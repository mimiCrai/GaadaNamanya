const username = process.env.MONGO_INITDB_ROOT_USERNAME;
const password = process.env.MONGO_INITDB_ROOT_PASSWORD;

function connect(host) {
    const connection = new Mongo(`mongodb://${host}/?directConnection=true`);
    connection.getDB('admin').auth(username, password);
    return connection;
}

function waitFor(description, operation) {
    for (let attempt = 0; attempt < 120; attempt++) {
        try {
            if (operation()) return;
        } catch (error) {
            if (attempt === 119) throw error;
        }
        sleep(1000);
    }
    throw new Error(`Timed out waiting for ${description}`);
}

function hosts(name) {
    return process.env.MONGO_KUBERNETES === 'true'
        ? [0, 1, 2].map((n) => `${name}-${n}.${name}:27017`)
        : [1, 2, 3].map((n) => `${name}-${n}:27017`);
}

for (const [name, members, configsvr] of [
    ['canonical-config', hosts('canonical-config'), true],
    ['canonical-shard-a', hosts('canonical-shard-a'), false],
    ['canonical-shard-b', hosts('canonical-shard-b'), false],
]) {
    waitFor(`${name} members`, () => members.every((host) => connect(host).getDB('admin').runCommand({ ping: 1 }).ok));
    const admin = connect(members[0]).getDB('admin');
    try {
        admin.runCommand({ replSetGetStatus: 1 });
    } catch (error) {
        if (error.code !== 94) throw error;
        admin.runCommand({
            replSetInitiate: {
                _id: name,
                ...(configsvr ? { configsvr: true } : {}),
                members: members.map((host, _id) => ({ _id, host })),
            },
        });
    }
    waitFor(`${name} primary`, () => members.some((host) => connect(host).getDB('admin').runCommand({ hello: 1 }).isWritablePrimary));
    print(`${name} ready`);
}
