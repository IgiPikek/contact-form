export default {
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
