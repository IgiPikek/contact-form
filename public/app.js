import Conversation from "/components/Conversation.js";
import ConversationPicker from "/components/ConversationPicker.js";

import { userKeys } from "/utils.js";

export function getApp({ reactive }, sid) {
    const [tenantId, entrypoint] = window.location.pathname.slice(1).split(`/`);
    const getJsonFromTenantWithSession = getJson(tenantId, entrypoint, sid);

    const state = reactive({
        currentPage: `login`,
        loginStep: 0,

        name: ``,
        pw: ``,
        pwType: `password`,
        pwBtnText: `Show`,
        captcha: ``,

        convos: [],
        selectedConvo: undefined,

        tenantId,
        entrypoint,

        tenantPublic: undefined,
        clientPublic: undefined,
        clientSecret: undefined,  // not sure whether it should be in vue data. Function scope might be safer

        admin: false,
        instanceOwner: false,

        entrypoints: [],

        waitingCreateEntrypoint: false,
        newEntrypointValid: false,
    });

    return {
        components: {
            Conversation,
            ConversationPicker,
        },

        setup() {

            return {
                sid,
                state,
            };
        },

        methods: {

            async goToPage(page) {
                this.state.currentPage = page;

                if (page === `messages` && state.admin) {
                    state.convos = (await this.getLatestMessages()).map(convo => ({ ...convo, stub: true }));
                }
                else if (page === `messages` && !state.admin) {
                    state.selectedConvo = await this.getConvo(state.clientPublic.toString(`hex`));
                }
                else if (page === `settings`) {
                    const epsRaw = await getEntrypoints(state.tenantPublic.toString(`hex`), state.authToken);
                    state.entrypoints = await decryptEntrypoints(epsRaw);
                }
            },

            togglePw() {
                if (state.pwType === `text`) {
                    state.pwType = `password`;
                    state.pwBtnText = `Show`;
                } else {
                    state.pwType = `text`;
                    state.pwBtnText = `Hide`;
                }
            },

            toCaptcha() {
                state.loginStep = 1;
                this.$nextTick(() => {
                    this.$refs.inpCaptcha.focus();
                });
            },

            async login() {
                const { clientPublic, clientSecret } = await userKeys(sodium, state.name, state.pw, state.tenantId, state.entrypoint);

                const pkHash = (await sodium.crypto_generichash(clientPublic.getBuffer())).toString(`hex`);

                console.log({ clientPublic: clientPublic.toString(`hex`), clientSecret: clientSecret.toString(`hex`), pkHash });


                const { json: cryptoToken } = await getJsonFromTenantWithSession(`auth?captcha=${state.captcha}&clientPublic=${clientPublic.toString(`hex`)}`)
                    .catch(() => {
                        state.captcha = ``;
                        // Trigger reloading the captcha.
                        this.$refs.imgCaptcha.src = this.$refs.imgCaptcha.src;
                    });

                if (!cryptoToken) return;

                const authToken = (await sodium.crypto_box_seal_open(await sodium.sodium_hex2bin(cryptoToken), clientPublic, clientSecret)).toString(`hex`);
                const {
                    headers,
                    json: tenantPublicHex,
                } = await getJsonFromTenantWithSession(`pk?captcha=${state.captcha}&clientPublic=${clientPublic.toString(`hex`)}`, authToken);
                // TODO handle failed request

                console.log(tenantPublicHex);

                state.admin = tenantPublicHex === clientPublic.toString(`hex`);
                state.instanceOwner = headers.get(`role`) === `instanceOwner`;
                state.authToken = authToken;

                state.tenantPublic = X25519PublicKey.from(await sodium.sodium_hex2bin(tenantPublicHex));
                state.clientPublic = clientPublic;
                state.clientSecret = clientSecret;

                this.goToPage(`messages`);
            },

            async getLatestMessages() {
                const { json: convos } = await getJsonFromTenantWithSession(`convos/latest`, state.authToken);
                return await Promise.all(convos.map(decryptConvo));
            },

            async getConvo(convoId, after) {
                let url = `convos/` + convoId;

                if (after) {
                    url += `?after=${after}`;
                }

                const { json: convo } = await getJsonFromTenantWithSession(url, state.authToken);
                return await decryptConvo(convo);
            },

            async sendResponse(convo, { text, attachment }, resetInput) {
                // TODO validate input
                console.log(text, convo);

                // name seems a bit easy to manipulate
                const plaintext = Message(state.name, text, attachment);
                const conversationKey = state.admin ? X25519PublicKey.from(await sodium.sodium_hex2bin(convo.id)) : state.clientPublic;
                const oppositePublic = state.admin
                    ? (convo.id === state.clientPublic.toString(`hex`) ? X25519PublicKey.from(await sodium.sodium_hex2bin(convo.io)) : conversationKey)
                    : state.tenantPublic;

                const payload = JSON.stringify({
                    epHash: convo.epHash,  // only available if admin and not inter-tenant
                    encryptedMessage: await createPayload({
                        plaintext,
                        conversationKey,
                        ownSecret: state.clientSecret,
                        oppositePublic,
                    }),
                });

                const ciphermsg = await submitResponse(tenantId, entrypoint, payload, state.authToken).then(res => res.json());
                console.log(ciphermsg);
                resetInput();

                const [message] = await decryptMessages(state.clientSecret, oppositePublic, [ciphermsg]);
                state.convos.find(c => c.id === convo.id).entries.splice(0, 0, message);
            },

            isSelf(name) {
                return state.name.toLowerCase() === name.toLowerCase();
            },

            async refresh() {
                if (!state.selectedConvo) return;

                const latestMsg = state.selectedConvo.entries.reduce((latest, entry) => latest.time > entry.time ? latest : entry, { time: -1 });
                const convoWithNewMessages = await this.getConvo(state.selectedConvo.id, latestMsg.time);

                state.selectedConvo.entries.push(...convoWithNewMessages.entries);
            },

            async convoChanged(convo) {
                if (convo.stub) {
                    const fullConvo = await this.getConvo(convo.id);
                    state.selectedConvo = fullConvo;
                    state.convos.splice(state.convos.findIndex(c => c.id === fullConvo.id), 1, fullConvo);
                } else {
                    state.selectedConvo = convo;
                }
            },

            async createEntrypoint(entrypoint) {
                state.waitingCreateEntrypoint = true;

                try {
                    const epsRaw = await createEntrypoint(entrypoint, state.tenantPublic.toString(`hex`), state.authToken);
                    state.entrypoints = await decryptEntrypoints(epsRaw);

                    this.newEp = ``;
                }
                finally {
                    state.waitingCreateEntrypoint = false;
                }
            },

            async deleteEntrypoint(event, entrypoint) {
                if (!confirm(`This will DELETE the entrypoint '${entrypoint}' with all its conversations. This CANNOT be undone. Continue deleting?`)) return;

                try {
                    event.target.disabled = true;
                    const epsRaw = await deleteEntrypoint(entrypoint, state.authToken);
                    state.entrypoints = await decryptEntrypoints(epsRaw);
                }
                finally {
                    event.target.disabled = false;
                }
            },

            validateNewEntrypoint(event) {
                state.newEntrypointValid = event.target.checkValidity() && !state.entrypoints.includes(this.newEp);
            },
        },
    };


    async function decryptConvo(convo) {
        const oppositePublic = state.admin
            ? X25519PublicKey.from(await sodium.sodium_hex2bin(state.instanceOwner ? convo.id : convo.io || convo.id))
            : state.tenantPublic;

        const entrypoint = convo.epId && (await sodium.crypto_box_seal_open(await sodium.sodium_hex2bin(convo.epId), state.clientPublic, state.clientSecret)).toString(`utf8`);
        const epHash = entrypoint && (await sodium.crypto_generichash(entrypoint)).toString(`hex`);

        return {
            id: convo.id,
            io: convo.io,
            entries: await decryptMessages(state.clientSecret, oppositePublic, convo.messages),
            fromTenant: state.instanceOwner && convo.ti && (await sodium.crypto_box_seal_open(await sodium.sodium_hex2bin(convo.ti), state.clientPublic, state.clientSecret)).toString(`utf8`),
            entrypoint,
            epHash,
        };
    }

    async function decryptMessages(ownSecret, oppositePublic, messages) {
        const decrypted = [];

        for (const { k, n, m, t } of messages) {
            const plainMsg = await sodium.crypto_box_open(
                await sodium.sodium_hex2bin(m),
                await sodium.sodium_hex2bin(n),
                ownSecret,
                oppositePublic
            );

            decrypted.push({
                ...JSON.parse(plainMsg.toString(`utf8`)),
                key: k,
                time: t,
            });
        }

        return decrypted;
    }

    function Message(name, msg, attachment = undefined) {
        return new TextEncoder().encode(JSON.stringify({ name, msg, attachment }));
    }

    async function createPayload({ plaintext, conversationKey, ownSecret, oppositePublic }) {
        const nonce = await sodium.randombytes_buf(sodium.CRYPTO_BOX_NONCEBYTES);
        const ciphertext = await sodium.crypto_box(plaintext, nonce, ownSecret, oppositePublic);

        return {
            k: conversationKey.toString(`hex`),
            n: nonce.toString(`hex`),
            m: ciphertext.toString(`hex`),
        };
    }

    function submitResponse(tenantId, entrypoint, payload, authToken) {
        return fetch(`/${tenantId}/${entrypoint}/message`, {
            method: `post`,
            headers: {
                "Authorization": authToken,
                "Content-Type": `application/json`,
                sid,
            },
            body: payload,
        });
    }

    function getJson(tenantId, entrypoint, sid) {
        return async (url, authToken = undefined) => {
            const headers = {
                "Content-Type": `application/json`,
                sid,
            };
            if (authToken) {
                headers.Authorization = authToken;
            }

            const res = await fetch(`/${tenantId}/${entrypoint}/${url}`, { headers });
            return {
                headers: res.headers,
                json: await res.json(),
            };
        };
    }

    function createEntrypoint(newEntrypoint, tenantPk, authToken) {
        return fetch(`/${tenantId}/${entrypoint}/entrypoint`, {
            method: `put`,
            headers: {
                "Authorization": authToken,
                "Content-Type": `application/json`,
                sid,
            },
            body: JSON.stringify({
                entrypoint: newEntrypoint,
                tenantPk,
            }),
        }).then(res => res.json());
    }

    function deleteEntrypoint(epToDelete, authToken) {
        return fetch(`/${tenantId}/${entrypoint}/entrypoint`, {
            method: `delete`,
            headers: {
                "Authorization": authToken,
                "Content-Type": `application/json`,
                sid,
            },
            body: JSON.stringify({
                entrypoint: epToDelete,
            }),
        }).then(res => res.json());
    }

    function getEntrypoints(tenantPk, authToken) {
        return fetch(`/${tenantId}/${entrypoint}/entrypoint`, {
            method: `get`,
            headers: {
                "Authorization": authToken,
                "Content-Type": `application/json`,
                sid,
            },
        }).then(res => res.json());
    }

    async function decryptEntrypoints(entrypoints) {
        const epsBytes = await Promise.all(Object.values(entrypoints)
            .map(async ep => sodium.crypto_box_seal_open(await sodium.sodium_hex2bin(ep), state.clientPublic, state.clientSecret)));

        return epsBytes.map(ep => ep.toString(`utf8`)).sort();
    }
}
