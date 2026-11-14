#!/bin/sh
set -eu

umask 077
mkdir -p /run/canonical-mongo
printf '%s' "$MONGO_CLUSTER_KEY" > /run/canonical-mongo/keyfile
chown mongodb:mongodb /run/canonical-mongo /run/canonical-mongo/keyfile /data/db

if [ "$1" = 'mongod' ] && [ ! -f /data/db/.canonical-initialized ]; then
    gosu mongodb mongod --dbpath /data/db --port 27018 --bind_ip 127.0.0.1 --fork --logpath /tmp/mongo-bootstrap.log
    mongosh --quiet --port 27018 --eval '
        const admin = db.getSiblingDB("admin");
        if (!admin.getUser(process.env.MONGO_INITDB_ROOT_USERNAME)) {
            admin.createUser({user: process.env.MONGO_INITDB_ROOT_USERNAME,
                pwd: process.env.MONGO_INITDB_ROOT_PASSWORD, roles: ["root"]});
        }
    '
    gosu mongodb mongod --dbpath /data/db --shutdown
    touch /data/db/.canonical-initialized
fi

if [ "$1" = 'mongod' ]; then
    set -- "$@" --setParameter "transactionLifetimeLimitSeconds=$MONGO_TRANSACTION_LIFETIME_SECONDS"
fi

exec gosu mongodb "$@" --keyFile /run/canonical-mongo/keyfile
