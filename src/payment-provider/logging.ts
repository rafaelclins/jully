// ---------- Logging seguro da integração (Etapa 16, seção 24) ----------
//
// Uniâo mínima e segura. Podemos registrar SOMENTE:
//   internalPaymentId (UUID de domínio), provider, operation,
//   result/categoria, durationMs (e, se útil, failureCode).
//
// NUNCA registrar: API key, Authorization header, PAN/CVV, payload bruto de
// provedor, query da webhook contendo dados sensíveis, nem providerPaymentId
// (identificador sensível do provedor — desnecessário nos logs).

export type ProviderLogKind = "create" | "status" | "webhook" | "reconcile";

export type ProviderOperationResult =
  | "created"
  | "replayed"
  | "pending"
  | "paid"
  | "failed"
  | "ambiguous"
  | "unchanged"
  | "terminal"
  | "no-op"
  | "duplicate"
  | "no-regress"
  | "applied"
  | "ignored";

export type ProviderLogDatum = {
  kind: ProviderLogKind;
  provider: string;
  operation: string;
  result: ProviderOperationResult;
  durationMs: number;
  internalPaymentId?: string;
  failureCode?: string;
};

export function logProviderOperation(datum: ProviderLogDatum): void {
  const parts = [
    `[payment-provider:${datum.kind}]`,
    `provider=${datum.provider}`,
    `operation=${datum.operation}`,
    `result=${datum.result}`,
    `durationMs=${datum.durationMs}`,
  ];
  if (datum.internalPaymentId) {
    parts.push(`internalPaymentId=${datum.internalPaymentId}`);
  }
  if (datum.failureCode) {
    parts.push(`failureCode=${datum.failureCode}`);
  }
  const line = parts.join(" ");
  if (datum.result === "ambiguous" || datum.result === "failed") {
    console.error(line);
  } else {
    console.info(line);
  }
}