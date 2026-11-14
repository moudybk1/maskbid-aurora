"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Hex } from "viem";
import { Alert, ConnectPrompt, Field, TxStatus } from "@/components/ui";
import { contracts } from "@/lib/client";
import { COPY } from "@/lib/copy";
import { useTx } from "@/lib/tx";
import { useWallet } from "@/lib/wallet";
import { write } from "@/lib/write";

const CATEGORIES = ["watch", "art", "digital_collectible", "other"];

export default function NewAsset() {
  const router = useRouter();
  const { address } = useWallet();
  const { state: tx, run } = useTx();
  const [f, setF] = useState({ title: "", description: "", category: "watch", condition: "", images: "", isDemo: true });
  const [frozen, setFrozen] = useState<{ uri: string; metadataHash: Hex }>();
  const [error, setError] = useState<string>();
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value });

  const freeze = async () => {
    setError(undefined);
    const res = await fetch("/api/metadata", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...f, images: f.images.split(/\s+/).filter(Boolean), issuerWallet: address }) });
    const j = await res.json();
    if (!res.ok) { setError(j.detail ?? "Metadata rejected"); return; }
    setFrozen(j);
  };

  const register = () => frozen && run("Register asset", (c) => write(c, contracts().asset, "registerAsset", [frozen.uri, frozen.metadataHash])).then(() => router.push("/sell")).catch(() => {});

  if (!address) return <div className="form stack"><h1>Register asset</h1><ConnectPrompt>Asset registration is signed by the issuer wallet.</ConnectPrompt></div>;
  return (
    <div className="form stack">
      <div><p className="caption"><a href="/sell">← Sell</a></p><h1>Register asset</h1><p className="muted">Metadata is frozen to a content hash before the registration transaction and cannot be edited afterwards. Private evidence is not part of public metadata.</p></div>
      <form onSubmit={(e) => { e.preventDefault(); freeze(); }} className="panel">
        <Field id="title" label="Title" help="3–120 characters"><input id="title" className="input" required minLength={3} maxLength={120} value={f.title} onChange={set("title")} disabled={Boolean(frozen)} /></Field>
        <Field id="category" label="Category"><select id="category" value={f.category} onChange={set("category")} disabled={Boolean(frozen)}>{CATEGORIES.map((c) => <option key={c} value={c}>{c.replace("_", " ")}</option>)}</select></Field>
        <Field id="condition" label="Condition"><input id="condition" className="input" required maxLength={80} value={f.condition} onChange={set("condition")} disabled={Boolean(frozen)} placeholder="e.g. excellent, serviced 2025" /></Field>
        <Field id="description" label="Description" help="Up to 5000 characters. No personal data."><textarea id="description" required maxLength={5000} value={f.description} onChange={set("description")} disabled={Boolean(frozen)} /></Field>
        <Field id="images" label="Image URLs" help="Up to 4 https URLs, one per line. Use images you have the right to publish."><textarea id="images" value={f.images} onChange={set("images")} disabled={Boolean(frozen)} style={{ minHeight: 80 }} /></Field>
        <label className="checkbox"><input type="checkbox" checked={f.isDemo} onChange={set("isDemo")} disabled={Boolean(frozen)} /><span>{COPY.demoAsset}</span></label>
        {error && <Alert tone="error">{error}</Alert>}
        {!frozen ? <button className="btn" type="submit" style={{ marginTop: 16 }}>Freeze metadata</button> : (
          <div className="stack" style={{ marginTop: 16 }}>
            <Alert tone="success" title="Metadata frozen"><span className="mono">{frozen.metadataHash}</span><br /><a href={frozen.uri} target="_blank" rel="noreferrer">{frozen.uri}</a></Alert>
            <p className="small muted">To change anything now, start a new draft; this hash will not be reused.</p>
            <div className="row"><button type="button" className="btn btn-secondary" onClick={() => setFrozen(undefined)}>Start over</button><button type="button" className="btn" onClick={register} disabled={tx.status === "signing" || tx.status === "confirming"}>Register on chain</button></div>
          </div>
        )}
        <TxStatus state={tx} />
      </form>
    </div>
  );
}
