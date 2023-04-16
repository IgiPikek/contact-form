import ConversationPickerItem from "./ConversationPickerItem.js";

export default {
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
