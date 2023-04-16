import { reactive } from "vue";

import Conversation from "./components/Conversation.js";
import ConversationPicker from "./components/ConversationPicker.js";

import { userKeys } from "/utils.js";

export function getApp(sid) {
    const tenantId = window.location.pathname;
    const getJsonFromTenantWithSession = getJson(tenantId, sid);

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
        tenantPublic: undefined,
        clientPublic: undefined,
        clientSecret: undefined,  // not sure whether it should be in vue data. Function scope might be safer

        admin: false,
        instanceOwner: false,
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

            goToPage(page) {
                this.state.currentPage = page;
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
                const { clientPublic, clientSecret } = await userKeys(sodium, state.name, state.pw);

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

                await this.getMessages();

                this.goToPage(`messages`);
            },

            async getMessages() {
                const clientPublicHex = state.clientPublic.toString(`hex`);
                const { json: convos } = await getJsonFromTenantWithSession(`convos/` + clientPublicHex, state.authToken);

                state.convos = await Promise.all(convos.map(async convo => {
                    const oppositePublic = state.admin
                        ? X25519PublicKey.from(await sodium.sodium_hex2bin(state.instanceOwner ? convo.id : convo.io))
                        : state.tenantPublic;

                    return ({
                        id: convo.id,
                        io: convo.io,
                        entries: (await decryptMessages(state.clientSecret, oppositePublic, convo.messages)).sort((a, b) => b.time - a.time),
                        fromTenant: state.instanceOwner && convo.ti && (await sodium.crypto_box_seal_open(await sodium.sodium_hex2bin(convo.ti), state.clientPublic, state.clientSecret)).toString(`utf8`),
                    });
                }));
            },

            async sendResponse(convo, replyText, resetInput) {
                // TODO validate input
                console.log(replyText, convo.id);

                // name seems a bit easy to manipulate
                const plaintext = Message(state.name, replyText);
                const conversationKey = state.admin ? X25519PublicKey.from(await sodium.sodium_hex2bin(convo.id)) : state.clientPublic;
                const oppositePublic = state.admin
                    ? (convo.id === state.clientPublic.toString(`hex`) ? X25519PublicKey.from(await sodium.sodium_hex2bin(convo.io)) : conversationKey)
                    : state.tenantPublic;

                const payload = await createPayload({
                    plaintext,
                    conversationKey,
                    ownSecret: state.clientSecret,
                    oppositePublic,
                });

                const ciphermsg = await submitResponse(tenantId, payload, state.authToken).then(res => res.text());
                console.log(ciphermsg);
                resetInput();

                const [message] = await decryptMessages(state.clientSecret, oppositePublic, [ciphermsg]);
                state.convos.find(c => c.id === convo.id).entries.splice(0, 0, message);
            },

            isSelf(name) {
                return state.name.toLowerCase() === name.toLowerCase();
            },

            convoChanged(convo) {
                state.selectedConvo = convo;
            },
        },
    };


    async function decryptMessages(ownSecret, oppositePublic, messages) {
        const decrypted = [];

        for (const message of messages) {
            const { k, n, m, t } = JSON.parse(message);
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

    function Message(name, msg) {
        return new TextEncoder().encode(JSON.stringify({ name, msg }));
    }

    async function createPayload({ plaintext, conversationKey, ownSecret, oppositePublic }) {
        const nonce = await sodium.randombytes_buf(sodium.CRYPTO_BOX_NONCEBYTES);
        const ciphertext = await sodium.crypto_box(plaintext, nonce, ownSecret, oppositePublic);

        return JSON.stringify({
            k: conversationKey.toString(`hex`),
            n: nonce.toString(`hex`),
            m: ciphertext.toString(`hex`),
        });
    }

    function submitResponse(tenantId, payload, authToken) {
        return fetch(`${tenantId}/message`, {
            method: `post`,
            headers: {
                "Authorization": authToken,
                "Content-Type": `application/json`,
                sid,
            },
            body: payload,
        });
    }

    function getJson(tenantId, sid) {
        return async (url, authToken = undefined) => {
            const headers = {
                "Content-Type": `application/json`,
                sid,
            };
            if (authToken) {
                headers.Authorization = authToken;
            }

            const res = await fetch(tenantId + `/` + url, { headers });
            return {
                headers: res.headers,
                json: await res.json(),
            };
        };
    }
}
