export interface ReceiveOrder {
    seq: number;
    index: number | null;
}

export const LEGACY_RECEIVE_ORDER: ReceiveOrder = { seq: 0, index: 0 };

export function formatReceiveOrder(order: ReceiveOrder): string {
    return `${String(order.seq).padStart(16, '0')}|${String(order.index ?? 0).padStart(6, '0')}`;
}
