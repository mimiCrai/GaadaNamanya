export class ApiError extends Error {
    constructor(
        message: string,
        public readonly status: number,
        /** Machine-readable code for the standard body `{"error":{"code":"...","message":"..."}}`. */
        public readonly code?: string
    ) {
        super(message);
    }
}
