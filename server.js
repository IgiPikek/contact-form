const env = require(`./env.json`);
const https = require(`https`);
const express = require(`express`);
const app = express();

const svgCaptcha = require(`svg-captcha`);

const fs = require(`fs`);
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
// TODO test if https redirect implementation is appropriate for live env


SodiumPlus.auto().then(async sodium => {

    app.set(`view engine`, `ejs`);
    app.set('views', Dirs.Views);


    app.use(express.static(Dirs.Public));

    app.use(express.json());



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

    const validateTenant = async (req, res, next) => {
        if (tenantCache.isEmpty()) {
            const activeTenants = DataAccess.activeTenants();
            tenantCache.add(...activeTenants);

            console.log(`active tenants from disk:`, activeTenants);
        }

        const hashedTenant = (await sodium.crypto_generichash(req.params.tenantId.toLowerCase())).toString(`hex`);

        console.log(`validate tenant`, req.params.tenantId, hashedTenant);

        if (!tenantCache.has(hashedTenant)) return res.status(404).send();

        req._hashedTenant = hashedTenant;
        next();
    };


    const tenant = route => `/:tenantId${route}`;


    app.get(tenant(`/`), validateTenant, (req, res) => {
        console.log(`:tenantId/`, req._hashedTenant);

        const session = Session.newSession();

        res.render(`index`, { tenant: req.params.tenantId, sid: session.id, prod: env.prod });
    });

    app.get(tenant(`/captcha`), requireSession, validateTenant, (req, res) => {
        const captcha = svgCaptcha.createMathExpr({ size: 20, noise: 8, mathMax: 12, mathOperator: `+-` });
        console.log(`captcha`, captcha.text);

        req._session.captcha = captcha.text;

        res.status(200)
            .type(`svg`)
            .send(captcha.data);
    });

    app.get(tenant(`/auth`), requireSession, validateTenant, async ({ query, _session }, res) => {
        // TODO avoid unlimited retries

        console.log(`captcha expected: ${_session.captcha}, is: ${query.captcha}`);
        if (!_session.captcha || query.captcha !== _session.captcha) return res.status(400).send();

        const authToken = await sodium.randombytes_buf(32);
        _session.authToken = authToken.toString(`hex`);

        const cryptoToken = await sodium.crypto_box_seal(authToken, X25519PublicKey.from(await sodium.sodium_hex2bin(query.clientPublic)));

        res.json(cryptoToken.toString(`hex`));
    });

    app.get(tenant(`/pk`), requireSession, validateTenant, withAuthRest, ({ query, _session, _hashedTenant }, res) => {
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

    app.get(tenant(`/convos/:convoId`), requireSession, validateTenant, withAuthRest, ({ _session, params, _hashedTenant }, res) => {
        const convoDirs = DataAccess.tenantConversations(_hashedTenant);

        if (_session.admin) {
            const convos = convoDirs.map(convoId => Conversation(
                convoId,
                DataAccess.convoMessages(_hashedTenant, convoId)
            ));

            const interTenant = _session.instanceOwner
                ? DataAccess.allInterTenantConvos()
                : [DataAccess.interTenantConvo(_session.pk)];

            return res.json([...convos, ...interTenant]);
        }

        const convoId = params.convoId;

        if (!convoDirs.includes(convoId)) {
            return res.json([Conversation(convoId)]);
        }

        const messages = DataAccess.convoMessages(_hashedTenant, convoId);
        const convo = Conversation(convoId, messages);

        console.log(convo);
        return res.json([convo]);
    });

    app.post(tenant(`/message`), requireSession, validateTenant, withAuthRest, async ({ body, _hashedTenant }, res) => {
        console.log(`SUBMIT`);

        // TODO validate fields
        console.log(body);

        // TODO perhaps there is a way to encrypt the data once more in order to hide who sent the message (can be seen from the key)
        // TODO signing or encrypting the data including the timestamp would be interesting in order to avoid manipulation
        const serialized = await DataAccess.storeMessage(_hashedTenant, body);

        res.send(serialized);
    });


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

        const encryptedMsg = req.body;
        const encryptedTenantId = await sodium.crypto_box_seal(tenant, X25519PublicKey.from(await sodium.sodium_hex2bin(DataAccess.instanceOwnerPk())));

        DataAccess.createTenant(tenantHash, encryptedMsg.k, encryptedTenantId.toString(`hex`));
        tenantCache.invalidate();

        await DataAccess.storeInterTenantMessage(encryptedMsg);

        res.send(`/` + tenant);
    });


    function Conversation(id, messages = []) {
        return { id, messages };
    }


    // TODO review whether it wouldn't be better to do https redirect via proxy e.g. nginx or apache
    const httpRedirect = express();
    httpRedirect.get(`/*`, (req, res) => {
        console.log(`host`, req.headers.host, `url`, req.url);
        res.redirect(`https://` + req.headers.host.replace(/\d+$/, env.port) + req.url);
    });
    httpRedirect.listen(env.httpPort, () => {
        console.log(`HTTP-redirect server running on port ${env.httpPort}`);
    });

    https.createServer({
        key: fs.readFileSync(env.ssl.key),
        cert: fs.readFileSync(env.ssl.cert),
    }, app).listen(env.port, () => {
        console.log(`HTTPS server running on port ${env.port}`);
    });

});

