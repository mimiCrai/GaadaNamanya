// Loaded only by the E2E override; simulate application clock changes without altering the host.
const SystemDate = Date;
let offset = 0;
global.Date = new Proxy(SystemDate, {
    construct(target, args, newTarget) {
        return Reflect.construct(target, args.length ? args : [SystemDate.now() + offset], newTarget);
    },
    apply() {
        return new SystemDate(SystemDate.now() + offset).toString();
    },
    get(target, key, receiver) {
        return key === 'now' ? () => SystemDate.now() + offset : Reflect.get(target, key, receiver);
    },
});
process.on('SIGUSR1', () => {
    offset = 45_000;
});
process.on('SIGUSR2', () => {
    offset = -30_000;
});
