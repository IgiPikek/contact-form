const env = require(`../env.json`);
const express = require(`express`);
const app = express();

const svgCaptcha = require(`svg-captcha`);

const path = require(`path`);

const { SodiumPlus, X25519PublicKey } = require(`sodium-plus`);

const Session = require(`./session`);
const DataAccess = require(`./dataAccess`);
const tenantCache = require(`./tenantCache`);

const Dirs = {
    Public: path.join(__dirname, `public`),
    Views: path.join(__dirname, `views`),
};


// TODO avoid multiple users using the same name but different passwords. Can cause confusion. Displaying user's public key mitigates.

// TODO trailing '/' causes error


SodiumPlus.auto().then(async sodium => {

    app.set(`view engine`, `ejs`);
    app.set('views', Dirs.Views);


    app.use(express.static(Dirs.Public));

    app.use(express.json({ limit: `11mb` }));

    app.use((req, res, next) => {
        res.removeHeader('X-Powered-By');
        next();
    });


    const requireSession = (req, res, next) => {
        Session.getSession(req.headers.sid || req.query.sid, session => {
            req._session = session;
            next();
        }).or(() => {
            console.log(`unknown session`, req.headers.sid);
            res.status(404).send();
        });
    };

    const withAuthRest = (req, res, next) => {
        console.log(`with auth`, req._session.authToken, req.headers.authorization);
        if (!req.headers.authorization || req.headers.authorization !== req._session.authToken) {
            return res.status(401).send();
        }
        next();
    };


    const entrypoint = route => `/:tenantId/:entrypoint${route}`;

    const validateEntrypoint = async (req, res, next) => {
        if (tenantCache.isEmpty()) {
            const activeTenants = DataAccess.activeTenants();
            tenantCache.add(...activeTenants);

            console.log(`active tenants from disk:`, activeTenants);
        }

        const hashedTenant = (await sodium.crypto_generichash(req.params.tenantId.toLowerCase())).toString(`hex`);
        const hashedEntrypoint = (await sodium.crypto_generichash(req.params.entrypoint.toLowerCase())).toString(`hex`);

        console.log(`validate tenant`, req.params.tenantId, hashedTenant, req.params.entrypoint, hashedEntrypoint);

        if (!tenantCache.has(hashedTenant) || !DataAccess.tenantEntrypointExists(hashedTenant, hashedEntrypoint)) {
            return res.status(404).send();
        }

        req._hashedTenant = hashedTenant;
        req._hashedEntrypoint = hashedEntrypoint;

        next();
    };


    app.get(`/new/:tenant`, async (req, res) => {
        console.log(`/new/:tenant`, req.params.tenant);

        const tenant = req.params.tenant;
        const tenantHash = (await sodium.crypto_generichash(tenant)).toString(`hex`);

        if (!DataAccess.tenantPending(tenantHash)) {
            return res.status(400).send();
        }

        const session = Session.newSession();
        const csrfToken = (await sodium.randombytes_buf(32)).toString(`hex`);

        session.csrfToken = csrfToken;

        res.render(`setup`, {
            tenant,
            sid: session.id,
            csrfToken,
            instanceOwnerPk: DataAccess.instanceOwnerPk(),
        });
    });

    app.post(`/new/:tenant`, requireSession, async (req, res) => {
        console.log(`post new`, req.body, req._session.csrfToken, req.headers.csrf);

        if (!req.headers.csrf || req._session.csrfToken !== req.headers.csrf) {
            return res.status(400).send();
        }

        const tenant = req.params.tenant;
        const tenantHash = (await sodium.crypto_generichash(tenant)).toString(`hex`);

        if (!DataAccess.tenantPending(tenantHash)) {
            return res.status(400).send();
        }

        const encryptedMsg = req.body.msg;
        const entrypoint = req.body.entrypoint;

        const instancePk = X25519PublicKey.from(await sodium.sodium_hex2bin(DataAccess.instanceOwnerPk()));
        const encryptedTenantId = await sodium.crypto_box_seal(tenant, instancePk);

        const entrypointHash = (await sodium.crypto_generichash(entrypoint)).toString(`hex`);

        const tenantPk = X25519PublicKey.from(await sodium.sodium_hex2bin(encryptedMsg.k));
        const encryptedEntrypoint = await sodium.crypto_box_seal(entrypoint, tenantPk);

        DataAccess.createTenant(tenantHash, encryptedMsg.k, encryptedTenantId.toString(`hex`), entrypointHash, encryptedEntrypoint.toString(`hex`));
        tenantCache.invalidate();

        await DataAccess.storeInterTenantMessage(encryptedMsg);

        res.send(`/${tenant}/${entrypoint}`);
    });


    app.get(entrypoint(`/`), validateEntrypoint, (req, res) => {
        console.log(`:tenantId/:entrypoint`, req._hashedTenant, req._hashedEntrypoint);

        const embedded = req.query.embedded === `true`;

        const session = Session.newSession();

        res.render(`index`, { tenant: req.params.tenantId, sid: session.id, prod: env.prod, embedded });
    });

    app.get(entrypoint(`/captcha`), requireSession, validateEntrypoint, (req, res) => {
        const captcha = svgCaptcha.createMathExpr({ size: 20, noise: 8, mathMax: 12, mathOperator: `+-` });
        console.log(`captcha`, captcha.text);

        req._session.captcha = captcha.text;

        res.status(200)
            .type(`svg`)
            .send(captcha.data);
    });

    app.get(entrypoint(`/auth`), requireSession, validateEntrypoint, async ({ query, _session }, res) => {
        // TODO avoid unlimited retries

        console.log(`captcha expected: ${_session.captcha}, is: ${query.captcha}`);
        if (!_session.captcha || query.captcha !== _session.captcha) return res.status(400).send();

        const authToken = await sodium.randombytes_buf(32);
        _session.authToken = authToken.toString(`hex`);

        const cryptoToken = await sodium.crypto_box_seal(authToken, X25519PublicKey.from(await sodium.sodium_hex2bin(query.clientPublic)));

        res.json(cryptoToken.toString(`hex`));
    });

    app.get(entrypoint(`/pk`), requireSession, validateEntrypoint, withAuthRest, ({ query, _session, _hashedTenant }, res) => {
        console.log(query, _session.captcha);

        const publicKeyRaw = DataAccess.tenantPk(_hashedTenant);

        // this field is probably not strictly necessary, but it might make the distinction between admin and visitors more obvious
        _session.admin = query.clientPublic === publicKeyRaw;

        if (_session.admin) {
            _session.pk = publicKeyRaw;
            const ownerKey = DataAccess.instanceOwnerPk();
            _session.instanceOwner = ownerKey === query.clientPublic;

            if (_session.instanceOwner) {
                console.log(`- instance owner -`);
                res.setHeader(`role`, `instanceOwner`);
            }
        }

        console.log(`pk raw`, publicKeyRaw);
        res.json(publicKeyRaw);
    });

    app.get(entrypoint(`/convos/latest`), requireSession, validateEntrypoint, withAuthRest, ({ _session, params, _hashedTenant }, res) => {
        if (!_session.admin) return res.status(400).send();

        const convosByEntrypoint = DataAccess.allTenantConvos(_hashedTenant);
        const latestOfConvos = convosByEntrypoint.flatMap(({ entrypointHash, epId, convos }) => convos.map(convoId => Conversation(
            convoId,
            [DataAccess.latestConvoMessage(_hashedTenant, entrypointHash, convoId)],
            epId
        )));

        const interTenant = _session.instanceOwner
            ? DataAccess.allInterTenantConvos({ sizeThreshold: true })
            : [DataAccess.interTenantConvo(_session.pk, 0, true)];

        interTenant.forEach(convo => {
            const latest = DataAccess.latestMessage(convo.messages);
            convo.messages = [latest];
        });
        return res.json([...latestOfConvos, ...interTenant]);
    });

    app.get(entrypoint(`/convos/:convoId`), requireSession, validateEntrypoint, withAuthRest, ({ _session, params, query, _hashedTenant, _hashedEntrypoint }, res) => {
        const { convoId } = params;
        const after = parseInt(query.after) || 0;

        if (_session.admin) {
            const convosByEntrypoint = DataAccess.allTenantConvos(_hashedTenant);
            const convos = convosByEntrypoint.flatMap(({ entrypointHash, epId, convos }) => convos
                .filter(conId => conId === convoId)
                .map(conId => Conversation(
                    conId,
                    DataAccess.convoMessagesWithThreshold(_hashedTenant, entrypointHash, conId, after),
                    epId
                ))
            );

            if (convos.length) {
                return res.json(convos[0]);
            }

            const allIinterTenant = _session.instanceOwner
                ? DataAccess.allInterTenantConvos({ after, sizeThreshold: true })
                : [DataAccess.interTenantConvo(_session.pk, after, true)];
            const interTenant = allIinterTenant.find(convo => convo.id === convoId);

            return res.json(interTenant);
        }

        const convoDirs = DataAccess.tenantEntrypointConvos(_hashedTenant, _hashedEntrypoint);

        if (!convoDirs.includes(convoId)) {
            return res.json(Conversation(convoId));
        }

        const messages = DataAccess.convoMessagesWithThreshold(_hashedTenant, _hashedEntrypoint, convoId, after);
        const convo = Conversation(convoId, messages);

        console.log(convo);
        return res.json(convo);
    });

    app.get(entrypoint(`/convos/:convoId/message/:nonce`), requireSession, validateEntrypoint, withAuthRest, ({ _session, params,  _hashedTenant, _hashedEntrypoint }, res) => {
        const { convoId, nonce } = params;

        if (_session.admin) {
            const convosByEntrypoint = DataAccess.allTenantConvos(_hashedTenant);
            const convos = convosByEntrypoint.flatMap(({ entrypointHash, epId, convos }) => convos
                .filter(conId => conId === convoId)
                .map(conId => Conversation(
                    conId,
                    [DataAccess.convoMessage(_hashedTenant, entrypointHash, conId, nonce)],
                    epId
                ))
            );

            if (convos.length) {
                return res.json(convos[0]);
            }

            const allIinterTenant = _session.instanceOwner
                ? DataAccess.allInterTenantConvos()
                : [DataAccess.interTenantConvo(_session.pk)];
            const interTenant = allIinterTenant.find(convo => convo.id === convoId);

            return res.json(interTenant);
        }


        const convoDirs = DataAccess.tenantEntrypointConvos(_hashedTenant, _hashedEntrypoint);

        if (!convoDirs.includes(convoId)) {
            return res.json(Conversation(convoId));
        }

        const message = DataAccess.convoMessage(_hashedTenant, _hashedEntrypoint, convoId, nonce);
        const convo = Conversation(convoId, [message]);

        return res.json(convo);
    });

    app.post(entrypoint(`/message`), requireSession, validateEntrypoint, withAuthRest, async ({ _session, body, _hashedTenant, _hashedEntrypoint }, res) => {
        console.log(`SUBMIT`);

        // TODO validate fields
        console.log(body);

        // TODO perhaps there is a way to encrypt the data once more in order to hide who sent the message (can be seen from the key)
        // TODO signing or encrypting the data including the timestamp would be interesting in order to avoid manipulation

        const targetEntrypoint = _session.admin ? body.epHash : _hashedEntrypoint;
        const stampedMessage = await DataAccess.storeMessage(_hashedTenant, targetEntrypoint, body.encryptedMessage);

        res.json(stampedMessage);
    });

    app.get(entrypoint(`/entrypoint`), requireSession, validateEntrypoint, withAuthRest, async ({ _session, _hashedTenant, _hashedEntrypoint }, res) => {
        const entrypoints = DataAccess.tenantEntrypoints(_hashedTenant);
        res.send(JSON.stringify(entrypoints));
    });

    app.put(entrypoint(`/entrypoint`), requireSession, validateEntrypoint, withAuthRest, async ({ _session, _hashedTenant, body }, res) => {
        if (!_session.admin) return res.status(400).send();

        const epToCreate = body.entrypoint;
        const entrypointHash = (await sodium.crypto_generichash(epToCreate)).toString(`hex`);

        if (DataAccess.tenantEntrypointExists(_hashedTenant, entrypointHash)) {
            return res.status(400).send();
        }

        const tenantPk = X25519PublicKey.from(await sodium.sodium_hex2bin(body.tenantPk));
        const encryptedEntrypoint = await sodium.crypto_box_seal(epToCreate, tenantPk);

        // Caution when using nodemon. Writing to disk restarts server and kills session.
        DataAccess.createEntrypoint(_hashedTenant, entrypointHash, encryptedEntrypoint.toString(`hex`));
        const entrypoints = DataAccess.tenantEntrypoints(_hashedTenant);

        res.status(201).send(JSON.stringify(entrypoints));
    });

    app.delete(entrypoint(`/entrypoint`), requireSession, validateEntrypoint, withAuthRest, async ({ _session, _hashedTenant, body }, res) => {
        if (!_session.admin) return res.status(400).send();

        const epToDelete = body.entrypoint;
        const entrypointHash = (await sodium.crypto_generichash(epToDelete)).toString(`hex`);

        DataAccess.deleteEntrypoint(_hashedTenant, entrypointHash);
        const entrypoints = DataAccess.tenantEntrypoints(_hashedTenant);

        res.status(200).send(JSON.stringify(entrypoints));
    });


    app.all(`*`, (req, res) => {
        res.end(`doesn't exist`);
    });


    app.listen(env.port, () => {
        console.log(`Node server listening on port ${env.port}`);
    });


    function Conversation(id, messages = [], epId = undefined) {
        return { id, messages, epId };
    }
});

