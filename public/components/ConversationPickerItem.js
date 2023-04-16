export default {
    props: [`convo`, `selected`],
    template: `#conversation-picker-item`,
    computed: {
        convoColor() {
            const instanceOwner = this.convo.id === this.$root.state.clientPublic.toString(`hex`);
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
            return this.convo.id === this.$root.state.clientPublic.toString(`hex`);
        },
        subTenant() {
            return this.convo.io === this.$root.state.clientPublic.toString(`hex`);
        },
    },
};
