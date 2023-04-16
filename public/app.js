export async function init(csrf) {
    const sodium = await SodiumPlus.auto();

    const Conversation = {
        // TODO lock Send button while waiting for response
        props: [`convo`],
        emits: [`reply`],
        template: `#conversation`,
        data() {
            return {
                replyText: ``,
            };
        },
        methods: {
            reply() {
                this.$emit(`reply`, this.convo.id, this.replyText, () => this.clear());
            },
            clear() {
                this.replyText = ``;
            },
            toUTCString: time => new Date(time).toUTCString(),
            isSelf(name) {
                return this.$root.name.toLowerCase() === name.toLowerCase();
            },
        },
    };



    Vue.createApp({
        components: {
            Conversation,
        },

        data() {
            return {
                currentPage: `login`,
                loginStep: 0,

                name: ``,
                pw: ``,
                pwType: `password`,
                pwBtnText: `Show`,
                captcha: ``,

                convos: [],

                tenantId: window.location.pathname,
                serverPublic: undefined,
                clientSecret: undefined,  // not sure whether it should be in vue data. Function scope might be safer

                admin: false,
            };
        },

        methods: {

            togglePw() {
                if (this.pwType === `text`) {
                    this.pwType = `password`;
                    this.pwBtnText = `Show`;
                } else {
                    this.pwType = `text`;
                    this.pwBtnText = `Hide`;
                }
            },

            toCaptcha() {
                this.loginStep = 1;
                this.$nextTick(() => {
                    this.$refs.inpCaptcha.focus();
                });
            },

            async login() {
                const encoder = new TextEncoder();

                const seed = encoder.encode(JSON.stringify({
                    name: this.name.trim().toLowerCase(),
                    pw: this.pw,
                }));
                const clientKeyPair = await sodium.crypto_kx_seed_keypair(seed);
                const clientPublic = await sodium.crypto_box_publickey(clientKeyPair);
                const clientSecret = await sodium.crypto_box_secretkey(clientKeyPair);

                const pkHash = (await sodium.crypto_generichash(clientPublic.getBuffer())).toString(`hex`);

                console.log({ clientPublic: clientPublic.toString(`hex`), clientSecret: clientSecret.toString(`hex`), pkHash });


                const cryptoToken = await fetch(`/auth?captcha=${this.captcha}&clientPublic=${clientPublic.toString(`hex`)}`)
                    .then(res => res.json())
                    .catch(() => {
                        this.captcha = ``;
                        // Trigger reloading the captcha.
                        this.$refs.imgCaptcha.src = this.$refs.imgCaptcha.src;
                    });

                if (!cryptoToken) return;

                const authToken = (await sodium.crypto_box_seal_open(await sodium.sodium_hex2bin(cryptoToken), clientPublic, clientSecret)).toString(`hex`);

                this.authToken = authToken;

                const serverPublicHex = await fetch(`${this.tenantId}/pk?captcha=${this.captcha}&clientPublic=${clientPublic.toString(`hex`)}`, {
                    headers: { "Authorization": authToken },
                }).then(res => res.json());

                // TODO handle failed request

                console.log(serverPublicHex);

                this.serverPublic = X25519PublicKey.from(await sodium.sodium_hex2bin(serverPublicHex));
                this.clientPublic = clientPublic;
                this.clientSecret = clientSecret;

                this.admin = serverPublicHex === clientPublic.toString(`hex`);

                await this.getMessages();

                this.currentPage = `messages`;
            },

            async getMessages() {
                const convos = await fetch(`${this.tenantId}/convos/` + this.clientPublic.toString(`hex`), {
                    headers: { "Authorization": this.authToken },
                }).then(res => res.json());

                console.log(convos);

                this.convos = await Promise.all(convos.map(async convo => {
                    const oppositePublic = this.admin ? X25519PublicKey.from(await sodium.sodium_hex2bin(convo.id)) : this.serverPublic;
                    return ({
                        id: convo.id,
                        entries: (await decryptMessages(this.clientSecret, oppositePublic, convo.messages)).sort((a, b) => b.time - a.time),
                    });
                }));
            },

            async sendResponse(convoId, replyText, resetInput) {
                // TODO validate input
                console.log(replyText, convoId);

                // name seems a bit easy to manipulate
                const plaintext = Message(this.name, replyText);
                const conversationKey = this.admin ? X25519PublicKey.from(await sodium.sodium_hex2bin(convoId)) : this.clientPublic;
                const oppositePublic = this.admin ? conversationKey : this.serverPublic;

                const payload = await createPayload({
                    plaintext,
                    conversationKey,
                    ownSecret: this.clientSecret,
                    oppositePublic,
                });

                const ciphermsg = await submitResponse(this.tenantId, payload, csrf, this.authToken).then(res => res.text());
                console.log(ciphermsg);
                resetInput();

                const [message] = await decryptMessages(this.clientSecret, oppositePublic, [ciphermsg]);
                this.convos.find(convo => convo.id === convoId).entries.splice(0, 0, message);
            },
        },
    }).mount('#app');


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

    function submitResponse(tenantId, payload, csrf, authToken) {
        return fetch(`${tenantId}/message`, {
            method: `post`,
            credentials: `include`,
            headers: {
                "csrf-token": csrf,
                "Authorization": authToken,
                "Content-Type": `application/json`,
            },
            body: payload,
        });
    }
}
