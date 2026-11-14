import { IntroGate } from "./IntroGate";
import { Stipple } from "./Stipple";

export const Lock = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><rect x="5" y="11" width="14" height="10" rx="2.5" /><path d="M8.5 11V8a3.5 3.5 0 0 1 7 0v3" /></svg>;
export const Arrow = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 8h10M9 4l4 4-4 4" /></svg>;

/** First screen. On the first visit of a session the wordmark sits in a grid, the envelope flies into the centre cell,
    and once the page is ready the cell opens into the whole sky (see .intro in globals.css and IntroGate). */
export function Hero() {
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="sky" aria-hidden="true">
        <Stipple kind="cloud" seed={11} className="cloud c1" />
        <Stipple kind="cloud" seed={23} className="cloud c2" />
        <Stipple kind="cloud" seed={37} className="cloud c3" />
        <Stipple kind="cloud" seed={41} className="cloud c4" />
        <Stipple kind="cloud" seed={53} className="cloud c5" />
      </div>
      <IntroGate />
      <div className="intro" aria-hidden="true">
        <span className="intro-window" />
        <span className="intro-word">MaskBid</span>
        <span className="intro-tag a">Private bids</span>
        <span className="intro-tag b">Clear outcomes</span>
      </div>
      <div className="hero-in container">
        <div className="hero-mark">
          <h1 id="hero-title" className="hero-title"><span>Private bids.</span><span>Clear outcomes.</span></h1>
          <Stipple kind="flight" seed={7} className="hero-flight" />
        </div>
        <div className="hero-foot">
          <p className="hero-sub">Your amount is encrypted in your browser and locked with a deposit. Only the winning bid is ever revealed.</p>
          <div className="row hero-ctas">
            <a className="btn" href="#lots">Explore auctions <Arrow /></a>
            <a className="btn btn-secondary" href="#start">Get started</a>
          </div>
        </div>
      </div>
    </section>
  );
}
