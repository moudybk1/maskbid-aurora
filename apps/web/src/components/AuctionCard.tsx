import { formatMoney, formatUnits6, TOKEN_SYMBOL } from "@maskbid/protocol";
import type { AuctionView } from "@/lib/data";
import { fmtRelative } from "@/lib/format";
import { AssetArt } from "./Dots";
import { Arrow } from "./Hero";
import { PhaseBadge } from "./ui";

function timing(v: AuctionView): string {
  const { a, phase, now } = v;
  if (phase === "Live") return `Closes ${fmtRelative(a.endTime, now)}`;
  if (phase === "Scheduled") return `Opens ${fmtRelative(a.startTime, now)}`;
  return `Closed ${fmtRelative(a.endTime, now)}`;
}

export function AuctionCard({ v, maxBids }: { v: AuctionView; maxBids: number }) {
  const { a, phase } = v;
  const img = v.metadata?.images?.[0];
  const sold = phase === "Claim" || phase === "Completed";
  return (
    <a className="lot-card card" href={`/auctions/${v.id}`}>
      <div className="lot-body">
        <div className="lot-top">
          <PhaseBadge phase={phase} />
          <span className="lot-ref">Lot {v.id.toString()} · token #{a.tokenId.toString()}</span>
        </div>
        <div>
          <p className="lot-cat">{v.metadata?.category?.replace("_", " ") ?? "Verified asset"}</p>
          <h3>{v.metadata?.title ?? `Asset #${a.tokenId.toString()}`}</h3>
          <p className="lot-line">{timing(v)} · deposit {formatMoney(a.depositUnits)}</p>
        </div>
        <div className="lot-price">
          <span>{sold ? "Winning bid" : "Reserve"}</span>
          <b>{formatUnits6(sold ? a.winningAmountUnits : a.reserveUnits)}<small>{TOKEN_SYMBOL}</small></b>
        </div>
        <div className="bidbar">
          <div className="bidbar-label"><span>{a.bidCount} sealed bid{a.bidCount === 1 ? "" : "s"}</span><span>{maxBids - a.bidCount} seats left</span></div>
          <div className="bidbar-track"><div className="bidbar-fill" style={{ width: `${(100 * a.bidCount) / maxBids}%` }} /></div>
        </div>
        <span className="lot-go">View lot <Arrow /></span>
      </div>
      <div className={`lot-art${img ? " photo" : ""}`}>
        {img ? <img src={img} alt="" loading="lazy" /> : <AssetArt seed={v.asset.metadataHash} />}
      </div>
    </a>
  );
}
