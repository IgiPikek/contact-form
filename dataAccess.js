module.exports = {
    activeTenants,
    allInterTenantConvos,
    allTenantConvos,
    convoMessages,
    latestConvoMessage,
    latestMessage,
    createEntrypoint,
    createTenant,
    deleteEntrypoint,
    instanceOwnerPk,
    interTenantConvo,
    storeInterTenantMessage,
    storeMessage,
    tenantEntrypointConvos,
    tenantEntrypointExists,
    tenantEntrypoints,
    tenantPending,
    tenantPk,
};

const fs = require(`fs`);
const path = require(`path`);

const { SodiumPlus } = require(`sodium-plus`);


const dataDir = path.join(__dirname, `data`);
const Dirs = {
    Tenants: path.join(dataDir, `tenants`),
    Tenant: tenantHash => path.join(Dirs.Tenants, tenantHash),
    TenantPublicKeyFile: tenantHash => path.join(Dirs.Tenant(tenantHash), `key`, `publicKey.js`),
    TenantEntrypoints: tenantHash => path.join(Dirs.Tenant(tenantHash), `entrypoints`),
    TenantEntrypoint: (tenantHash, entrypointHash) => path.join(Dirs.TenantEntrypoints(tenantHash), entrypointHash),
    TenantEntrypointIdFile: (tenantHash, entrypointHash) => path.join(Dirs.TenantEntrypoint(tenantHash, entrypointHash), `info.js`),
    TenantEntrypointConversations: (tenantHash, entrypointHash) => path.join(Dirs.TenantEntrypoint(tenantHash, entrypointHash), `conversations`),
    TenantEntrypointConversation: (tenantHash, entrypointHash, convoId) => path.join(Dirs.TenantEntrypointConversations(tenantHash, entrypointHash), convoId),
    TenantEntrypointMessage: (tenantHash, entrypointHash, convoId, messageHash) => path.join(Dirs.TenantEntrypointConversation(tenantHash, entrypointHash, convoId), messageHash),

    PendingTenants: path.join(dataDir, `pending-tenants`),
    PendingTenant: tenantHash => path.join(Dirs.PendingTenants, tenantHash),

    InterTenant: path.join(dataDir, `inter-tenant`),
    InterTenantConvos: path.join(dataDir, `inter-tenant`, `conversations`),
    InterTenantConvo: convoId => path.join(Dirs.InterTenantConvos, convoId),
    InterTenantMessage: (convoId, messageHash) => path.join(Dirs.InterTenantConvo(convoId), messageHash),
    InterTenantIdFile: convoId => path.join(Dirs.InterTenantConvo(convoId), `info.js`),

    InstanceOwnerKeyFile: path.join(dataDir, `inter-tenant`, `owner.js`),

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

function allTenantConvos(tenantHash) {
    return fs.readdirSync(Dirs.TenantEntrypoints(tenantHash))
        .map(ep => ({
            entrypointHash: ep,
            epId: require(Dirs.TenantEntrypointIdFile(tenantHash, ep)),
            convos: tenantEntrypointConvos(tenantHash, ep)
        }));
}

function convoMessages(tenantHash, entrypointHash, convoId) {
    return fs.readdirSync(Dirs.TenantEntrypointConversation(tenantHash, entrypointHash, convoId))
        .map(file => JSON.parse(fs.readFileSync(Dirs.TenantEntrypointMessage(tenantHash, entrypointHash, convoId, file), `utf8`)));
}

function latestConvoMessage(tenantHash, entrypointHash, convoId) {
    const messages = convoMessages(tenantHash, entrypointHash, convoId);
    return latestMessage(messages);
}

function latestMessage(messages) {
    return messages.reduce((latest, msg) => latest.t > msg.t ? latest : msg);
}

function createEntrypoint(tenantHash, entrypointHash, encryptedEntrypoint) {
    fs.mkdirSync(Dirs.TenantEntrypoint(tenantHash, entrypointHash));
    fs.mkdirSync(Dirs.TenantEntrypointConversations(tenantHash, entrypointHash));
    fs.writeFileSync(Dirs.TenantEntrypointIdFile(tenantHash, entrypointHash), `module.exports = "${encryptedEntrypoint}";\n`);
}

function createTenant(tenantHash, tenantPk, encryptedTenantId, entrypointHash, encryptedEntrypoint) {
    fs.writeFileSync(Dirs.TenantPublicKeyFile(tenantHash), `module.exports = "${tenantPk}";\n`);
    fs.rmSync(Dirs.PendingTenant(tenantHash));
    fs.mkdirSync(Dirs.InterTenantConvo(tenantPk));
    fs.writeFileSync(Dirs.InterTenantIdFile(tenantPk), `module.exports = "${encryptedTenantId}";\n`);
    createEntrypoint(tenantHash, entrypointHash, encryptedEntrypoint);
}

function deleteEntrypoint(tenantHash, entrypointHash) {
    fs.rmSync(Dirs.TenantEntrypoint(tenantHash, entrypointHash), { recursive: true, force: true });
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
            .map(file => JSON.parse(fs.readFileSync(Dirs.InterTenantMessage(convoId, file), `utf8`))),
    };
}

async function storeInterTenantMessage(encryptedMsg) {
    const { convoId, serialized, dataHash } = await serializeEncryptedMsg(encryptedMsg);

    fs.mkdirSync(Dirs.InterTenantConvo(convoId), { recursive: true });
    fs.writeFileSync(Dirs.InterTenantMessage(convoId, dataHash), serialized);

    return serialized;
}

/// Stores a message in the appropriate regular or inter-tenant conversation.
async function storeMessage(tenantHash, entrypointHash, encryptedMsg) {
    if (fs.readdirSync(Dirs.InterTenantConvos).includes(encryptedMsg.k)) {
        return await storeInterTenantMessage(encryptedMsg);
    }

    const { convoId, serialized, dataHash } = await serializeEncryptedMsg(encryptedMsg);

    fs.mkdirSync(Dirs.TenantEntrypointConversation(tenantHash, entrypointHash, convoId), { recursive: true });
    fs.writeFileSync(Dirs.TenantEntrypointMessage(tenantHash, entrypointHash, convoId, dataHash), serialized);

    return JSON.parse(serialized);
}

function tenantEntrypointConvos(tenantHash, entrypointHash) {
    return fs.readdirSync(Dirs.TenantEntrypointConversations(tenantHash, entrypointHash));
}

function tenantEntrypointExists(tenantHash, entrypointHash) {
    const epHashes = fs.readdirSync(Dirs.TenantEntrypoints(tenantHash));
    return epHashes.includes(entrypointHash);
}

function tenantEntrypoints(tenantHash) {
    const epHashes = fs.readdirSync(Dirs.TenantEntrypoints(tenantHash));
    return Object.fromEntries(epHashes.map(eph => [eph, require(Dirs.TenantEntrypointIdFile(tenantHash, eph))]))
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
