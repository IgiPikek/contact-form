module.exports = {
    newSession,
    getSession,
};


const sessions = new Map();


function newSession() {
    const session = {
        id: Math.random().toString(),
        captcha: undefined,
        authToken: undefined,
        admin: false,
    };

    sessions.set(session.id, session);
    return session;
}

function getSession(sid, then) {
    return {
        or: fn => {
            const session = sessions.get(sid);
            return session
                ? then(session)
                : fn();
        },
    };
}
