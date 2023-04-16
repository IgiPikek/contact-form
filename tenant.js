/**
 * This is a standalone script for CRUD operations on tenants.
 */

const fs = require(`fs`);
const path = require(`path`);
const { SodiumPlus } = require(`sodium-plus`);


SodiumPlus.auto().then(async sodium => {

    console.log(process.argv);

    const [cmd, ...args] = process.argv.slice(2);

    console.log(cmd, args);


    if ([`-c`, `--create`].includes(cmd)) {
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
        fs.mkdirSync(path.join(tenantDir, `messages`));

        fs.writeFileSync(path.join(`pending-tenants`, hashHex), ``);

        console.log(`Created tenant '${tenant}' as ${hashHex}`);
    } else {
        console.error(`Unknown command ${cmd}`);
    }

});
