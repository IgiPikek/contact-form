/**
 * This is a standalone script for CRUD operations on tenants.
 */

const fs = require(`fs`);
const path = require(`path`);
const { SodiumPlus } = require(`sodium-plus`);


SodiumPlus.auto().then(async sodium => {
    const [cmd, ...args] = process.argv.slice(2);

    const command = commands.find(c => c.short === cmd || c.long === cmd);

    if (command) {
        command.fn(sodium, cmd, args);
    } else {
        const cols = [12, 6, 20];
        const descPadding = cols.reduce((sum, col) => sum + col, 0);

        console.log();
        console.log(`Commands`.padEnd(cols[0]) + ``.padEnd(cols[1]) + `Arguments`.padEnd(cols[2]) + `Description`);
        console.log(`--------`.padEnd(cols[0]) + ``.padEnd(cols[1]) + `---------`.padEnd(cols[2]) + `-----------`);
        console.log();

        commands.forEach(({ long, short, args, desc }) => {
            console.log(
                long.padEnd(cols[0]) +
                short.padEnd(cols[1]) +
                args.padEnd(cols[2]) +
                desc.split(`\n`).map((line, i) => i > 0 ? Array(descPadding).fill(` `).join(``) + line : line).join(`\n`)
            );
        });
    }

});


const cmdCreate = {
    long: `--create`,
    short: `-c`,
    args: `[tenant-name]`,
    desc: `Creates a new tenant with the specified name.\nThe name appears in the URL and may differ from the tenant owner's name.`,
    fn: async (sodium, cmd, args) => {
        const [tenant] = args;

        if (!tenant) {
            console.error(`No tenant name specified.`);
            return;
        }

        // TODO centralise hash(str.toLower). It's too easy to forget.
        const hashHex = (await sodium.crypto_generichash(tenant.toLowerCase())).toString(`hex`);

        const tenantDir = path.join(`tenants`, hashHex);

        fs.mkdirSync(tenantDir);
        fs.mkdirSync(path.join(tenantDir, `key`));
        fs.mkdirSync(path.join(tenantDir, `entrypoints`));

        fs.writeFileSync(path.join(`pending-tenants`, hashHex), ``);

        console.log(`Created tenant '${tenant}' as ${hashHex}`);
    },
};

const cmdDelete = {
    long: `--delete`,
    short: `-d`,
    args: `[tenant-name]`,
    desc: `Deletes a tenant with all its conversations.\nThe associated URL will no longer be available.\nDeletion cannot be undone.`,
    fn: async (sodium, cmd, args) => {
        const [tenant] = args;

        if (!tenant) {
            console.error(`No tenant name specified.`);
            return;
        }

        // TODO centralise hash(str.toLower). It's too easy to forget.
        const hashHex = (await sodium.crypto_generichash(tenant.toLowerCase())).toString(`hex`);

        const tenantDir = path.join(__dirname, `tenants`, hashHex);

        try {
            // If tenant is pending, there is no key file yet and `require` would fail.
            const tenantKey = require(path.join(tenantDir, `key`, `publicKey.js`));
            fs.rmSync(path.join(`inter-tenant`, `conversations`, tenantKey), { recursive: true, force: true });
        } catch {
        }

        fs.rmSync(path.join(`pending-tenants`, hashHex), { force: true });
        fs.rmSync(tenantDir, { recursive: true, force: true });

        console.log(`Deleted tenant '${tenant}' (${hashHex})`);
    },
};

const cmdList = {
    long: `--list`,
    short: `-l`,
    args: ``,
    desc: `Lists tenant hashes and their pending state.`,
    fn: () => {
        const tenantsDir = `tenants`;
        const pendingDir = `pending-tenants`;

        const tenantHashes = fs.readdirSync(tenantsDir);
        const pendingTenants = fs.readdirSync(pendingDir).filter(p => p !== `.gitkeep`);

        const tenants = tenantHashes.map(tenant => ({ tenant, pending: pendingTenants.includes(tenant) }));
        const danglingPending = pendingTenants.filter(p => !tenantHashes.includes(p));
        const uninitializableTenants = tenants.filter(tenant => !tenant.pending && !fs.readdirSync(path.join(tenantsDir, tenant.tenant, `key`)).length);

        const tenantStatus = ({ tenant, pending }) => {
            if (pending) return tenant + ` (pending)`;
            if (uninitializableTenants.find(t => t.tenant === tenant)) return tenant + ` (uninitializable)`;
            return tenant;
        };

        console.log();
        console.log(`Tenants:`);
        tenants.forEach(t => console.log(tenantStatus(t)));

        if (danglingPending.length) {
            console.log();
            console.log(`Dangling pending tokens (should be deleted):`);
            danglingPending.forEach(pending => console.log(pending));
        }

        if (uninitializableTenants.length) {
            console.log();
            console.log(`Uninitialized but not pending tenants (delete tenant or manually recreate pending token):`);
            uninitializableTenants.forEach(t => console.log(t.tenant));
        }
    },
};

const commands = [
    cmdList,
    cmdCreate,
    cmdDelete,
];
