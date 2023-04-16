export async function init(sid) {
    const sodium = await SodiumPlus.auto();

    const tenantId = window.location.pathname;
    const getJsonFromTenantWithSession = getJson(tenantId, sid);

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
                this.$emit(`reply`, this.convo, this.replyText, () => this.clear());
            },
            clear() {
                this.replyText = ``;
            },
            toUTCString: time => new Date(time).toUTCString(),
        },
    };

    const ConversationPickerItem = {
        props: [`convo`, `selected`],
        template: `#conversation-picker-item`,
        computed: {
            convoColor() {
                const instanceOwner = this.convo.id === this.$root.clientPublic.toString(`hex`);
                const key = instanceOwner ? this.convo.io : this.convo.id;
                return `#` + key.slice(0, 6);
            },
            convoPartner() {
                const partnerEntry = this.convo.entries.find(e => !this.$root.isSelf(e.name));
                return partnerEntry?.name;
            },
            lastEntry() {
                return this.$parent.lastEntry(this.convo.entries);
            },
            lastMessage() {
                return this.lastEntry?.msg;
            },
            lastMessageDate() {
                const entryTime = this.lastEntry?.time;
                return entryTime && new Date(entryTime).toISOString().substring(0, 10) || `N/A`;
            },
            instanceOwner() {
                return this.convo.id === this.$root.clientPublic.toString(`hex`);
            },
            subTenant() {
                return this.convo.io === this.$root.clientPublic.toString(`hex`);
            },
        },
    };

    const ConversationPicker = {
        components: {
            ConversationPickerItem,
        },
        props: [`convos`],
        emits: [`selectionChanged`],
        template: `#conversation-picker`,
        data() {
            return {
                currentSelection: undefined,
            };
        },
        methods: {
            lastEntry(entries) {
                return entries.reduce((greatest, entry) => greatest.time > entry.time ? greatest : entry, {});
            },

            changeSelection(convo) {
                if (this.currentSelection === convo) return;

                this.currentSelection = convo;
                this.$emit(`selectionChanged`, convo);
            },
        },
        computed: {
            convosSorted() {
                // Results of `lastEntry` could be cached for higher efficiency.
                return this.convos.sort((a, b) => this.lastEntry(b.entries).time - this.lastEntry(a.entries).time);
            },
        },
    };


    Vue.createApp({
        components: {
            Conversation,
            ConversationPicker,
        },

        data() {
            return {
                sid,

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


                const { json: cryptoToken } = await getJsonFromTenantWithSession(`auth?captcha=${this.captcha}&clientPublic=${clientPublic.toString(`hex`)}`)
                    .catch(() => {
                        this.captcha = ``;
                        // Trigger reloading the captcha.
                        this.$refs.imgCaptcha.src = this.$refs.imgCaptcha.src;
                    });

                if (!cryptoToken) return;

                const authToken = (await sodium.crypto_box_seal_open(await sodium.sodium_hex2bin(cryptoToken), clientPublic, clientSecret)).toString(`hex`);
                const {
                    headers,
                    json: tenantPublicHex,
                } = await getJsonFromTenantWithSession(`pk?captcha=${this.captcha}&clientPublic=${clientPublic.toString(`hex`)}`, authToken);
                // TODO handle failed request

                console.log(tenantPublicHex);

                this.admin = tenantPublicHex === clientPublic.toString(`hex`);
                this.instanceOwner = headers.get(`role`) === `instanceOwner`;
                this.authToken = authToken;

                this.tenantPublic = X25519PublicKey.from(await sodium.sodium_hex2bin(tenantPublicHex));
                this.clientPublic = clientPublic;
                this.clientSecret = clientSecret;

                await this.getMessages();

                this.currentPage = `messages`;
            },

            async getMessages() {
                const clientPublicHex = this.clientPublic.toString(`hex`);
                const { json: convos } = await getJsonFromTenantWithSession(`convos/` + clientPublicHex, this.authToken);

                this.convos = await Promise.all(convos.map(async convo => {
                    const oppositePublic = this.admin
                        ? X25519PublicKey.from(await sodium.sodium_hex2bin(this.instanceOwner ? convo.id : convo.io))
                        : this.tenantPublic;

                    return ({
                        id: convo.id,
                        io: convo.io,
                        entries: (await decryptMessages(this.clientSecret, oppositePublic, convo.messages)).sort((a, b) => b.time - a.time),
                        fromTenant: this.instanceOwner && convo.ti && (await sodium.crypto_box_seal_open(await sodium.sodium_hex2bin(convo.ti), this.clientPublic, this.clientSecret)).toString(`utf8`),
                    });
                }));
            },

            async sendResponse(convo, replyText, resetInput) {
                // TODO validate input
                console.log(replyText, convo.id);

                // name seems a bit easy to manipulate
                const plaintext = Message(this.name, replyText);
                const conversationKey = this.admin ? X25519PublicKey.from(await sodium.sodium_hex2bin(convo.id)) : this.clientPublic;
                const oppositePublic = this.admin
                    ? (convo.id === this.clientPublic.toString(`hex`) ? X25519PublicKey.from(await sodium.sodium_hex2bin(convo.io)) : conversationKey)
                    : this.tenantPublic;

                const payload = await createPayload({
                    plaintext,
                    conversationKey,
                    ownSecret: this.clientSecret,
                    oppositePublic,
                });

                const ciphermsg = await submitResponse(tenantId, payload, this.authToken).then(res => res.text());
                console.log(ciphermsg);
                resetInput();

                const [message] = await decryptMessages(this.clientSecret, oppositePublic, [ciphermsg]);
                this.convos.find(c => c.id === convo.id).entries.splice(0, 0, message);
            },

            isSelf(name) {
                return this.name.toLowerCase() === name.toLowerCase();
            },

            convoChanged(convo) {
                this.selectedConvo = convo;
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
