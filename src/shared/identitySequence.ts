/**
 * Move an ascending PostgreSQL sequence past imported ids without lowering
 * its allocated high-water mark. The reserved value also covers an uncalled
 * sequence (setval(..., false)); gaps are allowed.
 */
export const syncPostgresSequence = (sequence: string, maximum: string): string =>
  `WITH sequence_state AS MATERIALIZED (SELECT nextval(${sequence}) AS value)
   SELECT setval(${sequence},
     GREATEST(COALESCE((${maximum}), 0), sequence_state.value, pg_sequence_last_value(${sequence})), true)
   FROM sequence_state`;
