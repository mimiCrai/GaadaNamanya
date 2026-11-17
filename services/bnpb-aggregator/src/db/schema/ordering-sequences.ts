export const orderingSequences = 'ordering_sequences';

// One monotonic counter per name (e.g. `PVMBG:receive`), advanced with an atomic $inc. 
export interface OrderingSequence {
    _id: string;
    value: number;
}
