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

for (const [name, hosts, configsvr] of [
    ['canonical-config', ['canonical-config-1:27017', 'canonical-config-2:27017', 'canonical-config-3:27017'], true],
    ['canonical-shard-a', ['canonical-shard-a-1:27017', 'canonical-shard-a-2:27017', 'canonical-shard-a-3:27017'], false],
    ['canonical-shard-b', ['canonical-shard-b-1:27017', 'canonical-shard-b-2:27017', 'canonical-shard-b-3:27017'], false],
]) {
    waitFor(`${name} members`, () => hosts.every((host) => connect(host).getDB('admin').runCommand({ ping: 1 }).ok));
    const admin = connect(hosts[0]).getDB('admin');
    try {
        admin.runCommand({ replSetGetStatus: 1 });
    } catch (error) {
        if (error.code !== 94) throw error;
        admin.runCommand({
            replSetInitiate: {
                _id: name,
                ...(configsvr ? { configsvr: true } : {}),
                members: hosts.map((host, _id) => ({ _id, host })),
            },
        });
    }
    waitFor(`${name} primary`, () => hosts.some((host) => connect(host).getDB('admin').runCommand({ hello: 1 }).isWritablePrimary));
    print(`${name} ready`);
}
