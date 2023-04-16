export async function userKeys(sodium, name, pw, tenant, entrypoint) {
    const encoder = new TextEncoder();

    const seed = encoder.encode(JSON.stringify({
        name: name.trim().toLowerCase(),
        pw,
        tenant: tenant.trim().toLowerCase(),
        entrypoint: entrypoint.trim().toLowerCase(),
    }));
    const clientKeyPair = await sodium.crypto_kx_seed_keypair(seed);
    const clientPublic = await sodium.crypto_box_publickey(clientKeyPair);
    const clientSecret = await sodium.crypto_box_secretkey(clientKeyPair);

    return {
        clientKeyPair,
        clientPublic,
        clientSecret,
    };
}
