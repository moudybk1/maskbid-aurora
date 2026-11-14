import { BrandMark } from "@/components/Dots";
import { ModeGate } from "@/components/ModeGate";
import { Nav } from "@/components/Nav";
import { WalletControl } from "@/components/WalletControl";

/** The product: every page behind "Launch app" shares this header with the wallet and the demo gate. */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header className="header">
        <div className="container header-in">
          <a className="brand" href="/"><BrandMark />MaskBid</a>
          <Nav />
          <div className="header-right"><ModeGate /><WalletControl /></div>
        </div>
      </header>
      <main className="container">{children}</main>
    </>
  );
}
