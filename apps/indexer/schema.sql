-- MaskBid Aurora v1: reference schema, NOT an automatic production migration.
-- PostgreSQL 16. Execute in an empty, isolated database. Owner must create schemas/roles.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA maskbid;
SET search_path TO maskbid, public;
CREATE DOMAIN evm_address AS text CHECK (VALUE ~ '^0x[0-9a-f]{40}$');
CREATE DOMAIN hash32 AS text CHECK (VALUE ~ '^0x[0-9a-f]{64}$');
CREATE DOMAIN uint256 AS numeric CHECK (VALUE = trunc(VALUE) AND VALUE >= 0 AND VALUE <= 115792089237316195423570985008687907853269984665640564039457584007913129639935);
CREATE TYPE auction_state AS ENUM ('Created','Active','Ended','PendingClaim','Finalized','Cancelled');
CREATE TYPE deposit_state AS ENUM ('Locked','Refunded','Consumed','Forfeited');
CREATE TYPE job_state AS ENUM ('queued','leased','submitted','succeeded','failed','dead');
CREATE TYPE verification_state AS ENUM ('not_available','available_unchecked','verified','failed');

CREATE TABLE deployments (
  chain_id bigint NOT NULL CHECK(chain_id > 0), auction_contract evm_address NOT NULL,
  asset_contract evm_address NOT NULL, participant_registry evm_address NOT NULL,
  payment_token evm_address NOT NULL, token_symbol text NOT NULL CHECK(token_symbol='mUSDC'),
  token_decimals smallint NOT NULL CHECK(token_decimals=6), profile text NOT NULL CHECK(profile IN ('normal','demo')),
  deployment_block bigint NOT NULL CHECK(deployment_block>=0), config_hash hash32 NOT NULL,
  solver_code_hash hash32 NOT NULL, near_adapter text NOT NULL, callback_sender evm_address NOT NULL,
  source_commit text NOT NULL CHECK(source_commit ~ '^[0-9a-f]{40}$'), abi_hash hash32 NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(chain_id,auction_contract)
);
CREATE TABLE auth_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), wallet evm_address NOT NULL,
  nonce_hash hash32 UNIQUE NOT NULL, message text NOT NULL, chain_id bigint NOT NULL,
  domain text NOT NULL, issued_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  consumed_at timestamptz, CHECK(expires_at > issued_at)
);
CREATE INDEX auth_challenges_expiry ON auth_challenges(expires_at);
CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), token_hash hash32 UNIQUE NOT NULL,
  wallet evm_address NOT NULL, csrf_hash hash32 NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, revoked_at timestamptz,
  CHECK(expires_at>created_at)
);
CREATE INDEX sessions_wallet_active ON sessions(wallet,expires_at) WHERE revoked_at IS NULL;
CREATE TABLE identity_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid NOT NULL REFERENCES sessions(id),
  wallet evm_address NOT NULL, provider text NOT NULL CHECK(provider IN ('world','simulator')),
  action text NOT NULL, binding_hash hash32 NOT NULL, nonce_hash hash32 UNIQUE NOT NULL,
  provider_environment text NOT NULL CHECK(provider_environment IN ('production','staging','sandbox','simulator')),
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, consumed_at timestamptz,
  CHECK(expires_at>created_at)
);
CREATE TABLE participants (
  chain_id bigint NOT NULL, registry evm_address NOT NULL, wallet evm_address NOT NULL,
  uniqueness_id hash32 NOT NULL, assurance text NOT NULL CHECK(assurance IN ('real_provider','simulator')),
  provider text NOT NULL, hmac_version smallint NOT NULL CHECK(hmac_version>0), proof_digest hash32 NOT NULL,
  verified_until timestamptz NOT NULL, revoked boolean NOT NULL DEFAULT false,
  registration_status text NOT NULL CHECK(registration_status IN ('verified_offchain','submitted','confirmed','failed')),
  tx_hash hash32, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(chain_id,registry,wallet), UNIQUE(chain_id,registry,uniqueness_id)
);
CREATE TABLE uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_wallet evm_address NOT NULL,
  purpose text NOT NULL CHECK(purpose IN ('asset_image','private_evidence')),
  object_key text UNIQUE NOT NULL, mime_type text NOT NULL CHECK(mime_type IN ('image/jpeg','image/png','image/webp')),
  byte_size bigint NOT NULL CHECK(byte_size>0 AND byte_size<=5242880), sha256 hash32,
  status text NOT NULL CHECK(status IN ('pending','quarantined','ready','rejected','deleted')),
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  CHECK(expires_at>created_at)
);
CREATE TABLE asset_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_wallet evm_address NOT NULL,
  title text NOT NULL CHECK(length(title) BETWEEN 3 AND 120), description text NOT NULL CHECK(length(description)<=5000),
  category text NOT NULL CHECK(category IN ('watch','art','digital_collectible','other')),
  condition_label text NOT NULL, is_demo boolean NOT NULL DEFAULT true,
  status text NOT NULL CHECK(status IN ('draft','frozen','registered','reviewed')),
  version integer NOT NULL DEFAULT 1 CHECK(version>0), metadata_uri text, metadata_hash hash32,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(status='draft' OR (metadata_uri IS NOT NULL AND metadata_hash IS NOT NULL))
);
CREATE INDEX asset_drafts_owner_page ON asset_drafts(owner_wallet,created_at DESC,id DESC);
CREATE TABLE draft_uploads (
  draft_id uuid NOT NULL REFERENCES asset_drafts(id), upload_id uuid NOT NULL REFERENCES uploads(id),
  position smallint NOT NULL CHECK(position BETWEEN 0 AND 3), PRIMARY KEY(draft_id,upload_id), UNIQUE(draft_id,position)
);
CREATE TABLE asset_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), draft_id uuid NOT NULL REFERENCES asset_drafts(id),
  reviewer evm_address NOT NULL, chain_id bigint NOT NULL, asset_contract evm_address NOT NULL, token_id uint256 NOT NULL, decision text NOT NULL CHECK(decision IN ('approve','reject')),
  reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000), metadata_hash hash32 NOT NULL,
  checklist_version text NOT NULL, review_digest hash32 NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  tx_hash hash32, status text NOT NULL CHECK(status IN ('recorded','submitted','confirmed','failed'))
);
CREATE TABLE chain_blocks (
  chain_id bigint NOT NULL, number bigint NOT NULL CHECK(number>=0), hash hash32 NOT NULL,
  parent_hash hash32 NOT NULL, block_time timestamptz NOT NULL, canonical boolean NOT NULL,
  PRIMARY KEY(chain_id,hash)
);
CREATE UNIQUE INDEX canonical_block_height ON chain_blocks(chain_id,number) WHERE canonical;
CREATE TABLE chain_events (
  id bigserial PRIMARY KEY, chain_id bigint NOT NULL, contract evm_address NOT NULL,
  tx_hash hash32 NOT NULL, log_index integer NOT NULL CHECK(log_index>=0), block_number bigint NOT NULL,
  block_hash hash32 NOT NULL, event_name text NOT NULL, decoded jsonb NOT NULL,
  canonical boolean NOT NULL DEFAULT true, applied_at timestamptz,
  UNIQUE(chain_id,tx_hash,log_index,block_hash), FOREIGN KEY(chain_id,block_hash) REFERENCES chain_blocks(chain_id,hash)
);
CREATE INDEX chain_events_replay ON chain_events(chain_id,contract,block_number,log_index) WHERE canonical;
CREATE TABLE indexer_checkpoints (
  chain_id bigint NOT NULL, contract evm_address NOT NULL, last_block bigint NOT NULL,
  last_block_hash hash32 NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL CHECK(state IN ('healthy','catching_up','reconciling','halted')),
  PRIMARY KEY(chain_id,contract)
);
CREATE TABLE assets (
  chain_id bigint NOT NULL, asset_contract evm_address NOT NULL, token_id uint256 NOT NULL,
  issuer evm_address NOT NULL, metadata_uri text NOT NULL, metadata_hash hash32 NOT NULL,
  draft_id uuid REFERENCES asset_drafts(id), verification_status text NOT NULL CHECK(verification_status IN ('Pending','Verified','Rejected')),
  minted boolean NOT NULL, redeemed boolean NOT NULL, reviewer evm_address, review_digest hash32,
  source_event_id bigint NOT NULL REFERENCES chain_events(id), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(chain_id,asset_contract,token_id), CHECK(NOT redeemed OR minted)
);
ALTER TABLE asset_reviews ADD CONSTRAINT review_asset_fk FOREIGN KEY(chain_id,asset_contract,token_id) REFERENCES assets(chain_id,asset_contract,token_id);
CREATE TABLE asset_balances (
  chain_id bigint NOT NULL, asset_contract evm_address NOT NULL, token_id uint256 NOT NULL,
  wallet evm_address NOT NULL, balance smallint NOT NULL CHECK(balance IN (0,1)),
  source_event_id bigint NOT NULL REFERENCES chain_events(id),
  PRIMARY KEY(chain_id,asset_contract,token_id,wallet),
  FOREIGN KEY(chain_id,asset_contract,token_id) REFERENCES assets(chain_id,asset_contract,token_id)
);
CREATE TABLE auction_keys (
  chain_id bigint NOT NULL, auction_contract evm_address NOT NULL, key_request_id hash32 NOT NULL,
  owner_wallet evm_address NOT NULL, key_id hash32, public_key_spki bytea, sealed_blob_hash hash32,
  sealed_blob_locator text, solver_code_hash hash32 NOT NULL, config_hash hash32 NOT NULL,
  status text NOT NULL CHECK(status IN ('requested','ready','consumed','failed')),
  source_event_id bigint NOT NULL REFERENCES chain_events(id),
  PRIMARY KEY(chain_id,auction_contract,key_request_id), UNIQUE(chain_id,auction_contract,key_id),
  FOREIGN KEY(chain_id,auction_contract) REFERENCES deployments(chain_id,auction_contract),
  CHECK(status NOT IN ('ready','consumed') OR (key_id IS NOT NULL AND public_key_spki IS NOT NULL AND sealed_blob_hash IS NOT NULL))
);
CREATE TABLE auctions (
  chain_id bigint NOT NULL, auction_contract evm_address NOT NULL, auction_id uint256 NOT NULL,
  asset_contract evm_address NOT NULL, token_id uint256 NOT NULL, seller evm_address NOT NULL,
  reserve_units uint256 NOT NULL, deposit_units uint256 NOT NULL, start_time timestamptz NOT NULL,
  end_time timestamptz NOT NULL, settlement_deadline timestamptz NOT NULL, state auction_state NOT NULL,
  key_id hash32 NOT NULL, solver_code_hash hash32 NOT NULL, config_hash hash32 NOT NULL,
  bid_count integer NOT NULL DEFAULT 0 CHECK(bid_count BETWEEN 0 AND 32), bid_digest hash32 NOT NULL,
  winner evm_address, winning_amount_units uint256, claim_deadline timestamptz,
  active_request_id hash32, active_attempt integer NOT NULL DEFAULT 0 CHECK(active_attempt BETWEEN 0 AND 3),
  cancel_reason text CHECK(cancel_reason IN ('SELLER_CANCELLED','NO_VALID_BID','WINNER_DEFAULT','SOLVER_TIMEOUT')),
  returned_asset_claimed boolean NOT NULL DEFAULT false, source_event_id bigint NOT NULL REFERENCES chain_events(id),
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(chain_id,auction_contract,auction_id),
  UNIQUE(chain_id,auction_contract,key_id),
  FOREIGN KEY(chain_id,auction_contract) REFERENCES deployments(chain_id,auction_contract),
  FOREIGN KEY(chain_id,asset_contract,token_id) REFERENCES assets(chain_id,asset_contract,token_id),
  FOREIGN KEY(chain_id,auction_contract,key_id) REFERENCES auction_keys(chain_id,auction_contract,key_id),
  CHECK(deposit_units>0 AND reserve_units>=deposit_units), CHECK(end_time>start_time), CHECK(settlement_deadline>end_time),
  CHECK(winning_amount_units IS NULL OR winning_amount_units>=reserve_units),
  CHECK(state NOT IN ('PendingClaim','Finalized') OR (winner IS NOT NULL AND winning_amount_units IS NOT NULL AND claim_deadline IS NOT NULL)),
  CHECK((state='Cancelled')=(cancel_reason IS NOT NULL))
);
CREATE INDEX auctions_catalog ON auctions(state,created_at DESC,auction_id DESC);
CREATE INDEX auctions_seller ON auctions(seller,created_at DESC);
CREATE INDEX auctions_due ON auctions(end_time) WHERE state IN ('Created','Active','Ended');
CREATE TABLE bids (
  chain_id bigint NOT NULL, auction_contract evm_address NOT NULL, auction_id uint256 NOT NULL,
  bid_index integer NOT NULL CHECK(bid_index BETWEEN 0 AND 31), bidder evm_address NOT NULL,
  identity_id hash32 NOT NULL, commitment hash32 NOT NULL, envelope bytea NOT NULL CHECK(octet_length(envelope)=490),
  deposit_units uint256 NOT NULL CHECK(deposit_units>0), deposit_status deposit_state NOT NULL,
  tx_hash hash32 NOT NULL, block_hash hash32 NOT NULL, block_number bigint NOT NULL, log_index integer NOT NULL,
  source_event_id bigint NOT NULL REFERENCES chain_events(id), created_at timestamptz NOT NULL,
  PRIMARY KEY(chain_id,auction_contract,auction_id,bid_index),
  UNIQUE(chain_id,auction_contract,auction_id,bidder), UNIQUE(chain_id,auction_contract,auction_id,identity_id),
  FOREIGN KEY(chain_id,auction_contract,auction_id) REFERENCES auctions(chain_id,auction_contract,auction_id)
);
CREATE INDEX bids_wallet_history ON bids(bidder,created_at DESC);
CREATE TABLE seller_credits (
  chain_id bigint NOT NULL, auction_contract evm_address NOT NULL, seller evm_address NOT NULL,
  amount_units uint256 NOT NULL, source_event_id bigint NOT NULL REFERENCES chain_events(id),
  PRIMARY KEY(chain_id,auction_contract,seller), FOREIGN KEY(chain_id,auction_contract) REFERENCES deployments(chain_id,auction_contract)
);
CREATE TABLE settlement_attempts (
  request_id hash32 PRIMARY KEY, chain_id bigint NOT NULL, auction_contract evm_address NOT NULL, auction_id uint256 NOT NULL,
  attempt integer NOT NULL CHECK(attempt BETWEEN 1 AND 3), bid_digest hash32 NOT NULL, bid_count integer NOT NULL CHECK(bid_count BETWEEN 0 AND 32),
  status text NOT NULL CHECK(status IN ('requested','executing','computed','callback_pending','accepted','failed','stale','timed_out')),
  manifest_sha256 hash32, manifest_object_key text, execution_id text,
  request_tx_hash hash32 NOT NULL, callback_tx_hash hash32, error_code text,
  started_at timestamptz NOT NULL, finished_at timestamptz,
  UNIQUE(chain_id,auction_contract,auction_id,attempt),
  FOREIGN KEY(chain_id,auction_contract,auction_id) REFERENCES auctions(chain_id,auction_contract,auction_id)
);
CREATE TABLE execution_evidence (
  request_id hash32 PRIMARY KEY REFERENCES settlement_attempts(request_id), execution_id text NOT NULL,
  input_sha256 hash32 NOT NULL, output_sha256 hash32 NOT NULL, wasm_sha256 hash32 NOT NULL,
  raw_output_object_key text NOT NULL, receipt_uri text, attestation_uri text,
  verification_status verification_state NOT NULL DEFAULT 'available_unchecked',
  checked_at timestamptz, verification_method text, verifier_version text, failure_code text,
  CHECK(verification_status<>'verified' OR (checked_at IS NOT NULL AND verification_method IS NOT NULL AND verifier_version IS NOT NULL))
);
CREATE TABLE transaction_tracking (
  chain_id bigint NOT NULL, tx_hash hash32 NOT NULL, owner_wallet evm_address NOT NULL,
  kind text NOT NULL CHECK(kind IN ('register_asset','verify_asset','prepare_key','create_auction','bid','claim','refund','expire','cancel','return_asset','withdraw_credit','redeem')),
  status text NOT NULL CHECK(status IN ('submitted','confirmed','reverted','dropped','replaced')),
  replacement_hash hash32, submitted_at timestamptz NOT NULL DEFAULT now(), checked_at timestamptz, error_code text,
  PRIMARY KEY(chain_id,tx_hash)
);
CREATE INDEX transaction_tracking_owner ON transaction_tracking(owner_wallet,submitted_at DESC);
CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind text NOT NULL CHECK(kind IN ('identity_registration','settlement_trigger','callback_delivery','upload_scan','reindex')),
  owner_wallet evm_address, resource_key text NOT NULL, state job_state NOT NULL DEFAULT 'queued',
  dedup_key text UNIQUE NOT NULL, payload jsonb NOT NULL, attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK(max_attempts>0), run_after timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz, lease_owner text, last_error_code text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_claim ON jobs(run_after,created_at) WHERE state IN ('queued','failed');
CREATE TABLE outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), topic text NOT NULL, aggregate_key text NOT NULL,
  dedup_key text UNIQUE NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz
);
CREATE INDEX outbox_pending ON outbox(created_at) WHERE delivered_at IS NULL;
CREATE TABLE idempotency_records (
  wallet evm_address NOT NULL, operation text NOT NULL, key text NOT NULL CHECK(length(key) BETWEEN 16 AND 128),
  request_hash hash32 NOT NULL, state text NOT NULL CHECK(state IN ('in_progress','complete')),
  status_code integer CHECK(status_code BETWEEN 100 AND 599), response_body jsonb,
  lease_until timestamptz NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(wallet,operation,key), CHECK(expires_at>created_at)
);
CREATE TABLE audit_log (
  id bigserial PRIMARY KEY, actor_wallet evm_address, actor_service text, action text NOT NULL,
  resource_key text NOT NULL, request_id text NOT NULL, safe_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), CHECK(actor_wallet IS NOT NULL OR actor_service IS NOT NULL)
);
CREATE INDEX audit_log_resource ON audit_log(resource_key,created_at DESC);

-- NOLOGIN group roles: a deployment creates separate LOGIN users and grants exactly one group.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='maskbid_api') THEN CREATE ROLE maskbid_api NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='maskbid_indexer') THEN CREATE ROLE maskbid_indexer NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='maskbid_worker') THEN CREATE ROLE maskbid_worker NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='maskbid_identity') THEN CREATE ROLE maskbid_identity NOLOGIN; END IF;
END $$;
REVOKE ALL ON SCHEMA maskbid FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA maskbid FROM PUBLIC;
GRANT USAGE ON SCHEMA maskbid TO maskbid_api,maskbid_indexer,maskbid_worker,maskbid_identity;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA maskbid TO maskbid_indexer,maskbid_api,maskbid_worker,maskbid_identity;
-- No anon/authenticated Supabase role receives any table access. All browser reads use the API.
DO $$ DECLARE t record; BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='maskbid' LOOP
    EXECUTE format('ALTER TABLE maskbid.%I ENABLE ROW LEVEL SECURITY',t.tablename);
    EXECUTE format('ALTER TABLE maskbid.%I FORCE ROW LEVEL SECURITY',t.tablename);
  END LOOP;
END $$;
-- Indexer owns projections only. It must never use a browser/service-role credential.
DO $$ DECLARE n text; BEGIN
  FOREACH n IN ARRAY ARRAY['chain_blocks','chain_events','indexer_checkpoints','assets','asset_balances','auction_keys','auctions','bids','seller_credits','settlement_attempts'] LOOP
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON maskbid.%I TO maskbid_indexer',n);
    EXECUTE format('CREATE POLICY indexer_write ON maskbid.%I TO maskbid_indexer USING (true) WITH CHECK (true)',n);
  END LOOP;
  FOREACH n IN ARRAY ARRAY['deployments','assets','asset_balances','auction_keys','auctions','bids','seller_credits','settlement_attempts','execution_evidence','indexer_checkpoints'] LOOP
    EXECUTE format('GRANT SELECT ON maskbid.%I TO maskbid_api,maskbid_worker',n);
    EXECUTE format('CREATE POLICY service_read ON maskbid.%I FOR SELECT TO maskbid_api,maskbid_worker USING (true)',n);
  END LOOP;
  FOREACH n IN ARRAY ARRAY['auth_challenges','sessions','identity_challenges','uploads','asset_drafts','draft_uploads','asset_reviews','transaction_tracking','jobs','outbox','idempotency_records'] LOOP
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON maskbid.%I TO maskbid_api',n);
    EXECUTE format('CREATE POLICY api_write ON maskbid.%I TO maskbid_api USING (true) WITH CHECK (true)',n);
  END LOOP;
  FOREACH n IN ARRAY ARRAY['jobs','outbox','uploads','transaction_tracking','execution_evidence'] LOOP
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON maskbid.%I TO maskbid_worker',n);
    EXECUTE format('CREATE POLICY worker_write ON maskbid.%I TO maskbid_worker USING (true) WITH CHECK (true)',n);
  END LOOP;
END $$;
GRANT SELECT ON deployments,asset_drafts,asset_reviews TO maskbid_indexer;
CREATE POLICY indexer_deploy_read ON deployments FOR SELECT TO maskbid_indexer USING(true);
CREATE POLICY indexer_draft_read ON asset_drafts FOR SELECT TO maskbid_indexer USING(true);
CREATE POLICY indexer_review_read ON asset_reviews FOR SELECT TO maskbid_indexer USING(true);
GRANT SELECT,INSERT,UPDATE ON participants TO maskbid_identity;
CREATE POLICY identity_write ON participants TO maskbid_identity USING(true) WITH CHECK(true);
GRANT SELECT ON participants TO maskbid_api;
CREATE POLICY api_participant_read ON participants FOR SELECT TO maskbid_api USING(true);
GRANT SELECT,UPDATE ON identity_challenges TO maskbid_identity;
CREATE POLICY identity_challenge_access ON identity_challenges TO maskbid_identity USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE ON jobs,outbox TO maskbid_identity;
CREATE POLICY identity_jobs ON jobs TO maskbid_identity USING(true) WITH CHECK(true);
CREATE POLICY identity_outbox ON outbox TO maskbid_identity USING(true) WITH CHECK(true);
GRANT INSERT ON audit_log TO maskbid_api,maskbid_worker,maskbid_indexer,maskbid_identity;
CREATE POLICY audit_append ON audit_log FOR INSERT TO maskbid_api,maskbid_worker,maskbid_indexer,maskbid_identity WITH CHECK(true);
-- Workflow status only; chain projections and draft contents remain outside worker write scope.
GRANT SELECT ON asset_drafts TO maskbid_worker;
GRANT UPDATE(status) ON asset_drafts TO maskbid_worker;
CREATE POLICY worker_draft_read ON asset_drafts FOR SELECT TO maskbid_worker USING(true);
CREATE POLICY worker_draft_status ON asset_drafts FOR UPDATE TO maskbid_worker USING(status IN ('frozen','registered','reviewed')) WITH CHECK(status IN ('registered','reviewed'));
-- Indexer enriches attempt progress from receipt-backed evidence; evidence never changes auction outcome.
GRANT SELECT ON execution_evidence TO maskbid_indexer;
CREATE POLICY indexer_evidence_read ON execution_evidence FOR SELECT TO maskbid_indexer USING(true);
COMMENT ON SCHEMA maskbid IS 'Reference v1; custom wallet sessions require server object authorization. RLS isolates services, not individual wallets.';
COMMIT;
