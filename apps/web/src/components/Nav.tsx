"use client";
import { usePathname } from "next/navigation";
import { useChainData } from "@/lib/data";
import { readConfig } from "@/lib/client";
import { useWallet } from "@/lib/wallet";

const LINKS = [["/auctions", "Auctions"], ["/sell", "Sell"], ["/activity", "My activity"]] as const;
// Seller flow pages live under /assets and /auctions/new but belong to "Sell".
const section = (p: string) => (p === "/sell" || p.startsWith("/assets") || p === "/auctions/new" ? "/sell" : p.startsWith("/activity") ? "/activity" : p.startsWith("/auctions") ? "/auctions" : p);

export function Nav() {
  const path = usePathname();
  const { address } = useWallet();
  const { data: isVerifier } = useChainData(async () => {
    return address !== undefined && (await readConfig()).verifier === address;
  }, [address], 30000);
  return (
    <nav className="nav" aria-label="Primary">
      {LINKS.map(([href, label]) => <a key={href} href={href} aria-current={section(path) === href ? "page" : undefined}>{label}</a>)}
      {isVerifier && <a href="/verifier" aria-current={path.startsWith("/verifier") ? "page" : undefined}>Verifier queue</a>}
    </nav>
  );
}
