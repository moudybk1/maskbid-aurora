"use client";
import { formatUnits6 } from "@maskbid/protocol";
import { BrandMark } from "@/components/Dots";
import { FlowStory } from "@/components/FlowStory";
import { Arrow, Hero } from "@/components/Hero";
import { PartsAccordion } from "@/components/PartsAccordion";
import { SealDemo } from "@/components/SealDemo";
import { Stipple } from "@/components/Stipple";
import { Reveal } from "@/components/ui";
import { loadAuctions, useChainData } from "@/lib/data";

const icon = (d: string) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;

const TRUST = [
  ["Encrypted before it leaves your device", "AES-256-GCM for the amount, RSA-OAEP-2048 for the key, bound to one auction.", icon("M6 11V8a6 6 0 0 1 12 0v3M5 11h14v10H5z")],
  ["Never the same twice", "Fresh key, IV and nonce on every seal, so equal bids look unrelated.", icon("M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3M18 3v4h-4M6 21v-4h4")],
  ["Checked against your receipt", "The commitment on chain must equal the one computed here.", icon("M20 6L9 17l-5-5")],
] as const;

const STACK = ["NEAR", "OutLayer TEE", "near-sdk (Rust)", "NEP-141", "NEP-171", "AES-256-GCM", "RSA-OAEP-2048", "keccak-256"];
const SEALED = [["Every losing bid amount", "forever"], ["Your amount before the close", "until settlement"], ["Bid plaintext", "only inside the solver"], ["Who offered how much", "only the winner is tied to a number"]];
const PUBLIC = [["Wallet addresses and deposits", "at bid time"], ["Ordered bid digest", "updated per bid"], ["Winner and winning amount", "after settlement"], ["Execution and output hashes", "on the evidence page"]];

const LINKS = [["#how", "How it works"], ["#seal", "Privacy"], ["#stack", "Stack"]] as const;

/** Landing page: what MaskBid is and why the bids stay private. The product itself lives behind "Launch app" (app/(app)). */
export default function Home() {
  const { data } = useChainData(loadAuctions, [], 15000);
  const all = data?.list ?? [];
  const settled = all.filter((v) => v.phase === "Completed").reduce((s, v) => s + v.a.winningAmountUnits, 0n);
  const stat = (n: number | string) => (data ? n : "—");

  return (
    <>
      <header className="header">
        <div className="container header-in">
          <a className="brand" href="/"><BrandMark />MaskBid</a>
          <nav className="nav" aria-label="Sections">{LINKS.map(([href, text]) => <a key={href} href={href}>{text}</a>)}</nav>
          <div className="header-right"><a className="btn btn-outline btn-sm" href="/auctions">Launch app <Arrow /></a></div>
        </div>
      </header>
      <main className="container">
        <div className="home">
          <Hero />

          <FlowStory />

          <section id="stack" className="sec container" aria-labelledby="parts-title">
            <Reveal className="sec-head">
              <p className="eyebrow">The stack</p>
              <h2 id="parts-title">Built from open, checkable parts</h2>
              <p>Nothing here asks you to trust a black box. Each stage runs on a public standard you can read and test.</p>
            </Reveal>
            <PartsAccordion />
          </section>

          <section id="seal" className="sec trust" aria-labelledby="seal-title">
            <Reveal className="container trust-head">
              <p className="eyebrow">Sealed in your browser</p>
              <h2 id="seal-title">Your bid becomes 490 bytes nobody can read</h2>
              <p className="tag-pill">Runs in this tab</p>
            </Reveal>
            <div className="trust-band">
              <div className="trust-demo">
                <Stipple kind="cloud" seed={61} className="cloud t1" />
                <Stipple kind="cloud" seed={67} className="cloud t2" />
                <SealDemo />
              </div>
              <ul className="trust-rows">
                {TRUST.map(([title, text, ic]) => <li key={title}><i>{ic}</i><div><h3>{title}</h3><p>{text}</p></div></li>)}
              </ul>
            </div>
          </section>

          <section className="navy" aria-labelledby="privacy-title">
            <div className="container">
              <Reveal className="sec-head">
                <p className="eyebrow">On chain</p>
                <h2 id="privacy-title">Sealed where it matters, public where it counts</h2>
                <p>Anyone can read what the contract on NEAR records. These totals come straight from this deployment.</p>
              </Reveal>
            </div>
            <div className="marquee">
              <div className="marquee-track">
                {STACK.map((s) => <span key={s}>{s}</span>)}
                {STACK.map((s) => <span key={`${s}-again`} aria-hidden="true">{s}</span>)}
              </div>
            </div>
            <div className="container">
              <Reveal className="figures">
                <Stipple kind="cloud" seed={71} className="cloud g1" />
                <Stipple kind="cloud" seed={73} className="cloud g2" />
                <Stipple kind="flight" seed={79} className="g3" />
                <div className="figure-main"><b>{stat(formatUnits6(settled))}</b><span>mUSDC settled</span></div>
                <div className="figure-side">
                  <p>Read from the chain right now</p>
                  <div className="figure-tiles">
                    <div><b>{stat(all.length)}</b><span>Lots listed</span></div>
                    <div><b>{stat(all.filter((v) => v.phase === "Live").length)}</b><span>Live right now</span></div>
                    <div><b>{stat(all.reduce((s, v) => s + v.a.bidCount, 0))}</b><span>Sealed bids placed</span></div>
                  </div>
                </div>
              </Reveal>
              <div className="ledger">
                <Reveal className="ledger-col">
                  <h3>Stays sealed</h3>
                  <ul>{SEALED.map(([what, when]) => <li key={what}>{what}<span className="chip peach">{when}</span></li>)}</ul>
                </Reveal>
                <Reveal className="ledger-col">
                  <h3>Public on NEAR</h3>
                  <ul>{PUBLIC.map(([what, when]) => <li key={what}>{what}<span className="chip mint">{when}</span></li>)}</ul>
                </Reveal>
              </div>
            </div>
          </section>

          <section className="sec container cta" aria-labelledby="cta-title">
            <Reveal className="cta-in">
              <h2 id="cta-title">Have something worth a sealed bid?</h2>
              <p>Register it, have a verifier approve it, then list it. Bidders compete on price without ever seeing each other&apos;s numbers.</p>
              <div className="row"><a className="btn" href="/auctions">Launch app <Arrow /></a><a className="btn btn-secondary" href="/sell">List an asset</a></div>
            </Reveal>
          </section>
        </div>
      </main>
    </>
  );
}
