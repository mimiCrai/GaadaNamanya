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
        checked(admin.runCommand({ addShard: `${name}/${name}-1:27017,${name}-2:27017,${name}-3:27017`, name }));
    }
}

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
print('Canonical Store: two shards and application user ready; collections are managed by migrations');
