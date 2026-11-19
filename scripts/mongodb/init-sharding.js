const connection = new Mongo('mongodb://canonical-store:27017');
const admin = connection.getDB('admin');
admin.auth(process.env.MONGO_INITDB_ROOT_USERNAME, process.env.MONGO_INITDB_ROOT_PASSWORD);

function checked(result) {
    if (!result.ok) throw new Error(JSON.stringify(result));
    return result;
}

checked(admin.runCommand({ setDefaultRWConcern: 1, defaultWriteConcern: { w: 'majority', j: true } }));
const currentShards = checked(admin.runCommand({ listShards: 1 })).shards.map((shard) => shard._id);
for (const name of ['canonical-shard-a', 'canonical-shard-b']) {
    if (!currentShards.includes(name)) {
        const hosts = process.env.MONGO_KUBERNETES === 'true'
            ? [0, 1, 2].map((n) => `${name}-${n}.${name}:27017`)
            : [1, 2, 3].map((n) => `${name}-${n}:27017`);
        checked(admin.runCommand({ addShard: `${name}/${hosts.join(',')}`, name }));
    }
}
checked(admin.runCommand({ balancerStart: 1 }));

const databaseName = process.env.CANONICAL_STORE_DB_NAME;
const database = connection.getDB(databaseName);
const username = process.env.CANONICAL_STORE_DB_USER;
if (!database.getUser(username)) {
    database.createUser({
        user: username,
        pwd: process.env.CANONICAL_STORE_DB_PASSWORD,
        roles: [{ role: 'readWrite', db: databaseName }],
    });
}
database.grantRolesToUser(username, [{ role: 'clusterMonitor', db: 'admin' }, { role: 'read', db: 'config' }]);
// Users created through mongos cannot authenticate directly against shard members.
// The owning Aggregator needs a shard-local monitoring identity for replica health.
for (const shard of checked(admin.runCommand({ listShards: 1 })).shards) {
    const [replicaSet, hosts] = shard.host.split('/');
    const peer = new Mongo(`mongodb://${hosts}/?replicaSet=${replicaSet}`);
    peer.getDB('admin').auth(process.env.MONGO_INITDB_ROOT_USERNAME, process.env.MONGO_INITDB_ROOT_PASSWORD);
    const local = peer.getDB(databaseName);
    if (!local.getUser(username)) {
        local.createUser({ user: username, pwd: process.env.CANONICAL_STORE_DB_PASSWORD,
            roles: [{ role: 'clusterMonitor', db: 'admin' }] });
    }
}
print('Canonical Store: two shards and application user ready; collections are managed by migrations');
