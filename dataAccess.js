module.exports = {
    activeTenants,
    allInterTenantConvos,
    convoMessages,
    createTenant,
    instanceOwnerPk,
    interTenantConvo,
    storeInterTenantMessage,
    storeMessage,
    tenantConversations,
    tenantPending,
    tenantPk,
};

const fs = require(`fs`);
const path = require(`path`);

const { SodiumPlus } = require(`sodium-plus`);


const Dirs = {
    Tenants: path.join(__dirname, `tenants`),
    Tenant: tenantHash => path.join(Dirs.Tenants, tenantHash),
    TenantPublicKeyFile: tenantHash => path.join(Dirs.Tenant(tenantHash), `key`, `publicKey.js`),
    TenantConversations: tenantHash => path.join(Dirs.Tenant(tenantHash), `conversations`),
    TenantConversation: (tenantHash, convoId) => path.join(Dirs.TenantConversations(tenantHash), convoId),
    TenantMessage: (tenantHash, convoId, messageHash) => path.join(Dirs.TenantConversations(tenantHash), convoId, messageHash),

    PendingTenants: path.join(__dirname, `pending-tenants`),
    PendingTenant: tenantHash => path.join(Dirs.PendingTenants, tenantHash),

    InterTenant: path.join(__dirname, `inter-tenant`),
    InterTenantConvos: path.join(__dirname, `inter-tenant`, `conversations`),
    InterTenantConvo: convoId => path.join(Dirs.InterTenantConvos, convoId),
    InterTenantMessage: (convoId, messageHash) => path.join(Dirs.InterTenantConvo(convoId), messageHash),
    InterTenantIdFile: convoId => path.join(Dirs.InterTenantConvo(convoId), `info.js`),

    InstanceOwnerKeyFile: path.join(__dirname, `inter-tenant`, `owner.js`),

    Public: path.join(__dirname, `public`),
    Views: path.join(__dirname, `views`),
};


function activeTenants() {
    const tenants = fs.readdirSync(Dirs.Tenants);
    const pending = fs.readdirSync(Dirs.PendingTenants);

    return tenants.filter(t => !pending.includes(t));
}

function allInterTenantConvos() {
    return fs.readdirSync(Dirs.InterTenantConvos)
        .map(interTenantConvo);
}

function convoMessages(tenantHash, convoId) {
    return fs.readdirSync(Dirs.TenantConversation(tenantHash, convoId))
        .map(file => fs.readFileSync(Dirs.TenantMessage(tenantHash, convoId, file), `utf8`));
}

function createTenant(tenantHash, tenantPk, encryptedTenantId) {
    fs.writeFileSync(Dirs.TenantPublicKeyFile(tenantHash), `module.exports = "${tenantPk}";\n`);
    fs.rmSync(Dirs.PendingTenant(tenantHash));
    fs.mkdirSync(Dirs.InterTenantConvo(tenantPk));
    fs.writeFileSync(Dirs.InterTenantIdFile(tenantPk), `module.exports = "${encryptedTenantId}";\n`);
}

function instanceOwnerPk() {
    return require(Dirs.InstanceOwnerKeyFile);
}

function interTenantConvo(convoId) {
    const convoDir = fs.readdirSync(Dirs.InterTenantConvo(convoId));
    const idFileFull = Dirs.InterTenantIdFile(convoId);
    const idFile = path.basename(idFileFull);

    const encTenantId = require(idFileFull);
    const msgFiles = convoDir.filter(msgFile => msgFile !== idFile);

    return {
        id: convoId,
        io: instanceOwnerPk(),  // instance owner
        ti: encTenantId,  // tenant ID, only required by instance owner
        messages: msgFiles
            .map(file => fs.readFileSync(Dirs.InterTenantMessage(convoId, file), `utf8`)),
    };
}

async function storeInterTenantMessage(encryptedMsg) {
    const { convoId, serialized, dataHash } = await serializeEncryptedMsg(encryptedMsg);

    fs.mkdirSync(Dirs.InterTenantConvo(convoId), { recursive: true });
    fs.writeFileSync(Dirs.InterTenantMessage(convoId, dataHash), serialized);

    return serialized;
}

/// Stores a message in the appropriate regular or inter-tenant conversation.
async function storeMessage(tenantHash, encryptedMsg) {
    if (fs.readdirSync(Dirs.InterTenantConvos).includes(encryptedMsg.k)) {
        return await storeInterTenantMessage(encryptedMsg);
    }

    const { convoId, serialized, dataHash } = await serializeEncryptedMsg(encryptedMsg);

    fs.mkdirSync(Dirs.TenantConversation(tenantHash, convoId), { recursive: true });
    fs.writeFileSync(Dirs.TenantMessage(tenantHash, convoId, dataHash), serialized);

    return serialized;
}

function tenantConversations(tenantHash) {
    return fs.readdirSync(Dirs.TenantConversations(tenantHash));
}

function tenantPending(tenantHash) {
    return fs.readdirSync(Dirs.PendingTenants).includes(tenantHash);
}

function tenantPk(tenantHash) {
    return require(Dirs.TenantPublicKeyFile(tenantHash));
}


async function serializeEncryptedMsg(encryptedMsg) {
    const sodium = await SodiumPlus.auto();
    const data = {
        ...encryptedMsg,
        t: Date.now(),  // timestamp
    };

    const convoId = data.k;
    const serialized = JSON.stringify(data);
    const dataHash = (await sodium.crypto_generichash(serialized)).toString(`hex`);

    return { convoId, serialized, dataHash };
}
