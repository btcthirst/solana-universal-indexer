// ─── Anchor IDL types (spec 0.1.0 / Anchor v0.29+) ───────────────────────────

// ─── Primitive types ──────────────────────────────────────────────────────────

export type AnchorPrimitive =
    | "bool"
    | "u8" | "i8"
    | "u16" | "i16"
    | "u32" | "i32"
    | "u64" | "i64"
    | "u128" | "i128"
    | "f32" | "f64"
    | "bytes"
    | "string"
    | "pubkey";   // v0.29+ uses "pubkey", older IDLs use "publicKey"

export type AnchorType =
    | AnchorPrimitive
    | { vec: AnchorType }
    | { array: [AnchorType, number] }
    | { option: AnchorType }
    | { defined: { name: string } }   // v0.29+: { defined: { name: "Offer" } }
    | { coption: AnchorType };

// ─── Field ────────────────────────────────────────────────────────────────────

export interface Field {
    name: string;
    type: AnchorType;
    docs?: string[];
}

// ─── PDA seeds ────────────────────────────────────────────────────────────────

export type PdaSeed =
    | { kind: "const"; value: number[] }
    | { kind: "arg"; path: string; type?: AnchorType }
    | { kind: "account"; path: string };

export interface PdaInfo {
    seeds: PdaSeed[];
    program?: PdaSeed;
}

// ─── Instruction account ──────────────────────────────────────────────────────

export interface AccountMeta {
    name: string;
    writable?: boolean;
    signer?: boolean;
    optional?: boolean;
    docs?: string[];
    pda?: PdaInfo;
    relations?: string[];
    address?: string;      // fixed address (system program, etc.)
    account?: string;      // account type (e.g., "Offer")
}

// ─── Instruction ──────────────────────────────────────────────────────────────

export interface ParsedInstruction {
    name: string;
    discriminator: number[];
    docs?: string[];
    args: Field[];
    accounts: AccountMeta[];
    returns?: AnchorType;
}

// ─── On-chain account (state) ─────────────────────────────────────────────────

export interface ParsedAccount {
    name: string;
    discriminator: number[];
    docs?: string[];
    fields?: Field[];
}

// ─── Custom types (structs & enums) ───────────────────────────────────────────

export interface StructTypeDef {
    kind: "struct";
    fields: Field[];
}

export interface EnumVariant {
    name: string;
    fields?: Field[];
}

export interface EnumTypeDef {
    kind: "enum";
    variants: EnumVariant[];
}

export interface ParsedTypeDef {
    name: string;
    docs?: string[];
    type: StructTypeDef | EnumTypeDef;
}

// ─── Events ───────────────────────────────────────────────────────────────────

export interface ParsedEvent {
    name: string;
    discriminator?: number[];
    docs?: string[];
    fields: Field[];
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export interface ParsedError {
    code: number;
    name: string;
    msg?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

export interface ParsedConstant {
    name: string;
    type: AnchorType;
    value: string;
}

// ─── Top-level ParsedIdl ──────────────────────────────────────────────────────

export interface ParsedIdl {
    address: string;
    name: string;
    version: string;
    spec?: string;
    description?: string;
    docs?: string[];

    instructions: ParsedInstruction[];
    accounts: ParsedAccount[];
    types: ParsedTypeDef[];
    events: ParsedEvent[];
    errors: ParsedError[];
    constants: ParsedConstant[];

    metadata: {
        origin: "file" | "network";
        loadedAt: string;
        sourcePath?: string;
    };
}