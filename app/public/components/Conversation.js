const Attachment = {
    props: {
        attachment: Object,  // Can be File or SerializedAttachment
        newMessage: Boolean,
        sending: Boolean,
    },
    emits: [`remove`, `download`],
    template: `#attachment`,
    computed: {
        objectURL() {
            URL.revokeObjectURL(this.objectURL);
            return URL.createObjectURL(deserializeAttachment(this.attachment));
        },
        isImage() {
            return this.attachment.type.startsWith(`image`);
        },
        size() {
            return Math.round(this.attachment.hexBytes?.length / 2 / 1024);
        },
    },
    beforeUnmount() {
        URL.revokeObjectURL(this.objectURL);
    },
};

export default {
    props: [`convo`],
    emits: [`reply`, `getMessage`],
    template: `#conversation`,
    components: { Attachment },
    data() {
        return {
            replyText: ``,
            attachment: undefined,
            imageBlobUrl: undefined,

            serializing: false,
            sending: false,
            downloadingLargeMsg: false,
            timestampFormatUTC: true,
        };
    },
    methods: {
        reply() {
            this.block();
            this.$emit(`reply`,
                this.convo,
                { text: this.replyText, attachment: this.attachment },
                { resetInput: () => this.clear(), unblockInput: () => this.unblock() }
            );
        },
        clear() {
            this.replyText = ``;
            this.removeAttachment();
            this.unblock();
        },
        block() {
            this.sending = true;
        },
        unblock() {
            this.sending = false;
        },
        async paste(e) {
            const clipboardItems = Array.from(e.clipboardData.items);
            const cbFile = clipboardItems.find(i => i.kind === `file`);

            if (!cbFile) return;

            this.removeAttachment();

            if (!await this.attachFile(cbFile.getAsFile())) {
                e.preventDefault();
            }
        },
        async attachFile(file) {
            if (file.size > 10 * 1024 * 1024) {
                alert(`File too large. Cannot be more than 10 MB.\nYour file size: ${(file.size / 1024 / 1024).toFixed(1)} MB`);
                return false;
            }

            this.serializing = true;
            this.attachment = await SerializedAttachment(file);
            this.serializing = false;

            if (file.type.startsWith(`image/`)) {
                this.imageBlobUrl = URL.createObjectURL(file);
            }

            return true;
        },
        removeAttachment() {
            URL.revokeObjectURL(this.imageBlobUrl);
            this.imageBlobUrl = undefined;
            this.attachment = undefined;
        },
        async fileInputChange({ target }) {
            if (!await this.attachFile(target.files[0])) {
                target.value = null;
            }
        },
        downloadLargeMessage(entry) {
            this.downloadingLargeMsg = true;
            this.$emit(`getMessage`, this.convo, entry.nonce, () => this.downloadingLargeMsg = false);
        },
        download(attachment) {
            const a = document.createElement(`a`);
            a.href = URL.createObjectURL(deserializeAttachment(attachment));
            a.download = attachment.name;
            a.click();
            URL.revokeObjectURL(a.href);
        },

        // Use only `from` once backward compatibility through `entry.name` becomes unnecessary.
        sender: entry => entry.name || entry.from?.name,
        toUTCString: time => new Date(time).toUTCString(),
        toLocalTime: time => new Date(time).toLocaleString(),
    },
    computed: {
        entriesLatestFirst() {
            return this.convo.entries.slice(0).sort((a, b) => b.time - a.time);
        },
        replyBlocked() {
            return this.sending || this.replyText.length === 0 && !this.attachment;
        },
    },
};


async function SerializedAttachment(blob) {
    return {
        hexBytes: await serializeBlob(blob),
        name: blob.name,
        type: blob.type,
        lastModified: blob.lastModified,
    };
}
async function serializeBlob(blob) {
    const buffer = await blob.arrayBuffer();
    return Array.from(new Uint8Array(buffer))
        .map(b => b.toString(16).padStart(2, `0`))
        .join(``).toUpperCase();
}

function deserializeAttachment(attachment) {
    const bytes = new Uint8Array(attachment.hexBytes.match(/../g).map(hexByte => parseInt(hexByte, 16)));
    return new File([bytes.buffer], attachment.name, { type: attachment.type, lastModified: attachment.lastModified });
}
