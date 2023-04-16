const env = require(`./env.json`);
const https = require(`https`);
const express = require(`express`);
const app = express();
const session = require(`express-session`);
const csrf = require(`csurf`);

const svgCaptcha = require(`svg-captcha`);

const fs = require(`fs`);
const path = require(`path`);

const { SodiumPlus, X25519PublicKey } = require(`sodium-plus`);

const Dirs = {
    Tenants: `tenants`,
    Tenant: tenantHash => path.join(Dirs.Tenants, tenantHash),
    TenantPublicKeyFile: tenantHash => path.join(Dirs.Tenant(tenantHash), `key`, `publicKey.js`),
    TenantConversations: tenantHash => path.join(Dirs.Tenant(tenantHash), `conversations`),
    TenantConversation: (tenantHash, convoId) => path.join(Dirs.TenantConversations(tenantHash), convoId),
    TenantMessage: (tenantHash, convoId, messageHash) => path.join(Dirs.TenantConversations(tenantHash), convoId, messageHash),

    PendingTenants: `pending-tenants`,
    PendingTenant: tenantHash => path.join(Dirs.PendingTenants, tenantHash),

    Public: path.join(__dirname, `public`),
    Views: path.join(__dirname, `views`),
};


// TODO avoid multiple users using the same name but different passwords. Can cause confusion. Displaying user's public key mitigates.

// TODO trailing '/' causes error
// TODO rework session handling. Especially with regard to csrf
// TODO test if https redirect implementation is appropriate for live env


SodiumPlus.auto().then(async sodium => {

    // TODO maybe rename, to convey that it can only be used to secure rest api calls
    const withAuthRest = (req, res, next) => {
        console.log(`with auth`, req.session.data.authToken, req.headers.authorization);
        if (!req.headers.authorization || req.headers.authorization !== req.session.data.authToken) {
            return res.status(401).send();
        }
        next();
    };


    app.set(`view engine`, `ejs`);
    app.set('views', Dirs.Views);

    app.use(session({
        resave: false,
        saveUninitialized: false,
        name: `sid`,
        secret: `asf8ha@wtepfasijdg08sharigowueibt0ps8rgohiwi3jtwio`,  // TODO should probably be regenerated on startup
        unset: `destroy`,
    }));

    app.use(csrf({}));

    app.use(express.static(Dirs.Public));

    app.use(express.json());


    app.use(({ session }, _, next) => {
        if (!session.data) {
            // Session data is bundled in 'data' property for easy clearing.
            // Always provide a default value so other handlers don't have to check for its existence.
            // TODO only set it after login. If set, a session cookie will be sent, which shall not happen before login
            session.data = {};
        }
        next();
    });



    let tenants;

    const validateTenant = async (req, res, next) => {
        if (!tenants) {
            tenants = fs.readdirSync(Dirs.Tenants);
            console.log(`stored tenants from disk:`, tenants);
        }

        const hashedTenant = (await sodium.crypto_generichash(req.params.tenantId.toLowerCase())).toString(`hex`);
        req._hashedTenant = hashedTenant;

        console.log(`validate tenant`, req.params.tenantId, hashedTenant);

        if (!tenants.includes(hashedTenant)) return res.status(404).send();

        next();
    };


    app.get(`/captcha`, ({ session }, res) => {
        const captcha = svgCaptcha.createMathExpr({ size: 20, noise: 8, mathMax: 12, mathOperator: `+-` });
        console.log(captcha.text);

        session.data = { captcha: captcha.text };
        res.status(200)
            .type(`svg`)
            .send(captcha.data);
    });

    app.get(`/auth`, async ({ query, session }, res) => {
        // TODO avoid unlimited retries
        console.log(session.data.captcha);
        if (!session.data.captcha || query.captcha !== session.data.captcha) return res.status(400).send();

        const authToken = await sodium.randombytes_buf(32);
        session.data.authToken = authToken.toString(`hex`);

        const cryptoToken = await sodium.crypto_box_seal(authToken, X25519PublicKey.from(await sodium.sodium_hex2bin(query.clientPublic)));

        res.json(cryptoToken.toString(`hex`));
    });

    app.get(`/new/:tenant`, async (req, res) => {
        console.log(`/new/:tenant`, req.params.tenant);

        const tenant = req.params.tenant;
        const tenantHash = (await sodium.crypto_generichash(tenant)).toString(`hex`);

        if (!fs.readdirSync(Dirs.PendingTenants).includes(tenantHash)) {
            return res.status(400).send();
        }

        res.render(`setup`, { tenant, csrf: req.csrfToken() });
    });

    app.post(`/new/:tenant`, async (req, res) => {
        console.log(`post new`, req.body);

        const tenant = req.params.tenant;
        const tenantHash = (await sodium.crypto_generichash(tenant)).toString(`hex`);

        if (!fs.readdirSync(Dirs.PendingTenants).includes(tenantHash)) {
            return res.status(400).send();
        }

        fs.writeFileSync(Dirs.TenantPublicKeyFile(tenantHash), `module.exports = "${req.body.pk}";\n`);
        fs.rmSync(Dirs.PendingTenant(tenantHash));

        res.send(`/` + tenant);
    });


    const tenant = route => `/:tenantId${route}`;

    app.get(tenant(`/`), validateTenant, (req, res) => {
        console.log(`:tenantId/`, req._hashedTenant);

        // TODO do not render pending tenants. Trying to log into pending tenant throws error because public key doesn't exist yet.
        res.render(`index`, { tenant: req.params.tenantId, csrf: req.csrfToken(), prod: env.prod });
    });

    app.get(tenant(`/pk`), validateTenant, withAuthRest, ({ query, session, _hashedTenant }, res) => {
        console.log(query, session.data.captcha);

        const publicKeyRaw = require(`.` + path.sep + Dirs.TenantPublicKeyFile(_hashedTenant));

        // this field is probably not strictly necessary, but it might make the distinction between admin and visitors more obvious
        // TODO must be unset when logging out. or the session must be destroyed
        // Must be set every time as there currently is no proper logout mechanism. Meaning the session would remain 'admin' even after page reload (pseudo-logout)
        session.data.admin = query.clientPublic === publicKeyRaw;

        res.json(publicKeyRaw);
    });

    app.post(tenant(`/message`), validateTenant, withAuthRest, async ({ body, _hashedTenant }, res) => {
        console.log(`SUBMIT`);

        // TODO validate
        const data = body;
        const convoId = data.k;

        data.t = Date.now();
        console.log(data);

        const serialized = JSON.stringify(data);

        // TODO perhaps there is a way to encrypt the data once more in order to hide who sent the message (can be seen from the key)
        // TODO signing or encrypting the data including the timestamp would be interesting in order to avoid manipulation

        const dataHash = (await sodium.crypto_generichash(serialized)).toString(`hex`);
        console.log(dataHash);

        fs.mkdirSync(Dirs.TenantConversation(_hashedTenant, convoId), { recursive: true });
        fs.writeFileSync(Dirs.TenantMessage(_hashedTenant, convoId, dataHash), serialized);

        res.send(serialized);
    });

    app.get(tenant(`/convos/:convoId`), validateTenant, withAuthRest, ({ session, params, _hashedTenant }, res) => {
        const convoDirs = fs.readdirSync(Dirs.TenantConversations(_hashedTenant));

        if (session.data.admin) {
            const convos = convoDirs.map(convoId => Conversation(
                convoId,
                readFilesSync(Dirs.TenantConversation(_hashedTenant, convoId))
            ));
            return res.json(convos);
        }

        const convoId = params.convoId;

        if (!convoDirs.includes(convoId)) {
            return res.json([Conversation(convoId)]);
        }

        const messages = readFilesSync(Dirs.TenantConversation(_hashedTenant, convoId));

        const convo = Conversation(convoId, messages);

        console.log(convo);
        return res.json([convo]);
    });

    function Conversation(id, messages = []) {
        return { id, messages };
    }
    function readFilesSync(dir) {
        return fs.readdirSync(dir)
            .map(file => fs.readFileSync(path.join(dir, file), `utf8`));
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

