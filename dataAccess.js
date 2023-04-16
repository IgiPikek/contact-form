module.exports = {
    activeTenants,
    convoMessages,
    createTenant,
    storeMessage,
    tenantConversations,
    tenantPending,
    tenantPk,
};

const fs = require(`fs`);
const path = require(`path`);


const Dirs = {
    Tenants: path.join(__dirname, `tenants`),
    Tenant: tenantHash => path.join(Dirs.Tenants, tenantHash),
    TenantPublicKeyFile: tenantHash => path.join(Dirs.Tenant(tenantHash), `key`, `publicKey.js`),
    TenantConversations: tenantHash => path.join(Dirs.Tenant(tenantHash), `conversations`),
    TenantConversation: (tenantHash, convoId) => path.join(Dirs.TenantConversations(tenantHash), convoId),
    TenantMessage: (tenantHash, convoId, messageHash) => path.join(Dirs.TenantConversations(tenantHash), convoId, messageHash),

    PendingTenants: path.join(__dirname, `pending-tenants`),
    PendingTenant: tenantHash => path.join(Dirs.PendingTenants, tenantHash),

    Public: path.join(__dirname, `public`),
    Views: path.join(__dirname, `views`),
};


function activeTenants() {
    const tenants = fs.readdirSync(Dirs.Tenants);
    const pending = fs.readdirSync(Dirs.PendingTenants);

    return tenants.filter(t => !pending.includes(t));
}

function convoMessages(tenantHash, convoId) {
    return fs.readdirSync(Dirs.TenantConversation(tenantHash, convoId))
        .map(file => fs.readFileSync(Dirs.TenantMessage(tenantHash, convoId, file), `utf8`));
}

function createTenant(tenantHash, tenantPk) {
    fs.writeFileSync(Dirs.TenantPublicKeyFile(tenantHash), `module.exports = "${tenantPk}";\n`);
    fs.rmSync(Dirs.PendingTenant(tenantHash));
}

function storeMessage(tenantHash, convoId, messageHash, serializedMsg) {
    fs.mkdirSync(Dirs.TenantConversation(tenantHash, convoId), { recursive: true });
    fs.writeFileSync(Dirs.TenantMessage(tenantHash, convoId, messageHash), serializedMsg);
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
