module.exports = {
    add,
    has,
    isEmpty,
    invalidate,
};


const tenants = new Set();


function add(...entries) {
    entries.forEach(entry => tenants.add(entry));
}

function has(tenant) {
    return tenants.has(tenant);
}

function isEmpty() {
    return !tenants.size;
}

function invalidate() {
    tenants.clear();
}
