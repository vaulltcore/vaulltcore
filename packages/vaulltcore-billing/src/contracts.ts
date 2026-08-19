/**
 * Billing ledger contracts (Phase 1E).
 *
 * Billing is kept separate from raw usage. The pipeline is:
 *
 *   UsageEvent → aggregation → pricing calculation → immutable LedgerEntry
 *
 * Pricing is versioned: a {@link PricingVersion} pins the unit prices used for
 * a charge, and a later price change never rewrites historical charges (every
 * ledger entry references the pricing version it was priced under). No
 * external payment processor is integrated in this phase — only internal
 * accounting primitives (charge/debit, adjustment/credit, idempotent
 * settlement).
 *
 * A duplicate usage event can never create a duplicate financial charge: the
 * ledger entry carries a UNIQUE `(scope, source_ref)` idempotency key that maps
 * to the source usage event/aggregate, so re-pricing or re-delivery collapses
 * to one charge.
 */

import type { JobIdentity } from "@vaulltcore/runner"
import type { UsageKind } from "@vaulltcore/metering"

/** A versioned price table. */
export interface PricingVersion {
  readonly pricingId: string
  readonly version: string
  /** Per-unit price in micro-currency (integer) to avoid float drift. */
  readonly unitPrices: Readonly<Record<UsageKind, number>>
  readonly effectiveAt: number
  readonly createdAt: number
}

export const LEDGER_ENTRY_TYPES = ["charge", "adjustment"] as const
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number]

/** An immutable accounting entry. */
export interface LedgerEntry {
  readonly entryId: string
  readonly tenantId: string
  readonly orgId: string
  readonly projectId: string
  readonly jobId: string | null
  readonly type: LedgerEntryType
  /** +charge / -credit; micro-currency. */
  readonly amount: number
  /** Pricing version this entry was priced under (immutable reference). */
  readonly pricingId: string
  readonly pricingVersion: string
  /** Source usage reference (usage event id or aggregate key). */
  readonly sourceRef: string
  /** Idempotency key: UNIQUE (scope, source_ref) prevents duplicate charges. */
  readonly idempotencyKey: string
  readonly createdAt: number
}

export class BillingError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = "BillingError"
  }
}

export interface BillingScope extends JobIdentity {
  readonly jobId: string | null
}

/** A charge to be priced and recorded. */
export interface ChargeInput {
  readonly identity: BillingScope
  readonly kind: UsageKind
  readonly quantity: number
  /** Source usage reference (usage event id or aggregate key). */
  readonly sourceRef: string
  /** Idempotency key, normally `scope|sourceRef`. */
  readonly idempotencyKey: string
}

/** Account balance for a scope (sum of charges/adjustments). */
export interface AccountBalance {
  readonly tenantId: string
  readonly orgId: string
  readonly projectId: string
  readonly balance: number
  readonly charges: number
  readonly credits: number
}
