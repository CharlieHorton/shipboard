/** Self-contained, compact dashboard styling. No network fonts or assets. */
export const CSS = `
*{box-sizing:border-box}
:root{
  color-scheme:light;
  --bg:#f3f2ed;--panel:#fffefa;--fg:#21363c;--muted:#657278;--line:#dce0d9;--hover:#edf2ed;
  --accent:#16715f;--accent-soft:#e7f2eb;--ink:#102e38;--mint:#72dcc6;
  --wait-fg:#56626b;--wait-bg:#eaece9;
  --agent-fg:#965013;--agent-bg:#fcf0db;
  --human-fg:#245bac;--human-bg:#e8effc;
  --merged-fg:#176a56;--merged-bg:#e0f1e8;
  --done-fg:#567263;--done-bg:#edf2eb;
  --blocked-fg:#ae3437;--blocked-bg:#fde9e7;
  --shadow:0 2px 5px #16362b05;
}
@media (prefers-color-scheme:dark){:root{
  color-scheme:dark;
  --bg:#101d22;--panel:#17282e;--fg:#e7eeea;--muted:#a1b2b5;--line:#30434a;--hover:#22383e;
  --accent:#83dfc3;--accent-soft:#213d38;--ink:#0c2028;--mint:#72dcc6;
  --wait-fg:#bec9cb;--wait-bg:#2c3c42;
  --agent-fg:#f4c27b;--agent-bg:#453723;
  --human-fg:#a6caff;--human-bg:#253d59;
  --merged-fg:#8fddbb;--merged-bg:#234238;
  --done-fg:#a8c6b4;--done-bg:#283b32;
  --blocked-fg:#ffa8a4;--blocked-bg:#4d2a2e;
  --shadow:none;
}}
body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
h1,h2,h3,p{overflow-wrap:anywhere}
h1,h2,h3{margin:0;font-weight:650}
h1{font-size:27px;letter-spacing:-1px;line-height:1.25}
h2{font-size:15px;letter-spacing:-.25px}
h3{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
a{color:inherit;text-underline-offset:3px}
a:hover{color:var(--accent)}
button,select{font:inherit;color:inherit;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:5px 10px;cursor:pointer;min-height:30px}
button:hover:enabled,select:hover{background:var(--hover);border-color:var(--muted)}
button:disabled{opacity:.55;cursor:default}
:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
[hidden]{display:none!important}
.muted{color:var(--muted)}
.id{font:11px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--muted);font-variant-numeric:tabular-nums}
header.top{display:flex;align-items:center;gap:18px;padding:12px 24px;background:var(--ink);color:#f6f2e9;border-bottom:1px solid #ffffff12;position:sticky;top:0;z-index:3;min-height:70px}
.brand{display:flex;align-items:center;gap:10px;flex-shrink:0;text-decoration:none}
.brand:hover{color:#fff}
.brand-icon,.brand-icon svg{display:block;width:38px;height:38px}
.wordmark{font-size:19px;font-weight:700;letter-spacing:-.5px;line-height:1.2}
.wordmark small{display:block;font-size:8px;font-weight:500;letter-spacing:1.8px;color:#abc2c5;margin-top:4px}
header.top nav{display:flex;gap:4px;margin-left:20px}
header.top nav a{font-size:12px;text-decoration:none;padding:7px 10px;border-radius:5px;color:#c2d4d6}
header.top nav a:hover{color:#fff;background:#ffffff0d}
header.top .spacer{flex:1}
header.top select{background:#ffffff0b;border-color:#ffffff25;color:#f6f2e9;max-width:180px}
header.top option{background:var(--ink);color:#f6f2e9}
#synced{color:#b4c9cc;font-size:11px;max-width:185px}
#synced:before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:#9eafb2;margin-right:7px;vertical-align:1px}
#synced.needs-checking:before{background:#f4bf76}
#sync-btn{color:#102e38;background:var(--mint);border-color:var(--mint);font-weight:650;min-width:66px}
#sync-btn:hover:enabled{background:#a1eddc;border-color:#a1eddc}
header.top :focus-visible{outline-color:var(--mint)}
main{padding:24px;display:flex;flex-direction:column;gap:16px;max-width:1920px;margin:0 auto;min-width:0}
.overview{display:flex;justify-content:space-between;align-items:center;gap:20px;padding:0 0 4px}
.eyebrow{margin:0 0 6px;font:10px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;text-transform:uppercase;letter-spacing:1.3px;color:var(--muted)}
.metrics{display:flex;gap:28px;margin:0}
.metrics>div{display:flex;flex-direction:column-reverse;min-width:72px;padding-left:18px;border-left:1px solid var(--line)}
.metrics dt{color:var(--muted);font-size:11px}
.metrics dd{margin:0;font-size:25px;font-weight:600;letter-spacing:-1px;font-variant-numeric:tabular-nums;line-height:1.3}
section{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;box-shadow:var(--shadow);min-width:0;scroll-margin-top:90px}
section>h2{margin-bottom:12px}
.section-heading{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:14px}
.section-heading>.muted{font-size:11px}
.section-note{font-size:12px;margin:-7px 0 12px}
.badge{display:inline-block;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:550;line-height:17px;white-space:nowrap;background:var(--wait-bg);color:var(--wait-fg)}
.s-agent{background:var(--agent-bg);color:var(--agent-fg)}
.s-human{background:var(--human-bg);color:var(--human-fg)}
.s-merged{background:var(--merged-bg);color:var(--merged-fg)}
.s-done{background:var(--done-bg);color:var(--done-fg)}
.s-blocked{background:var(--blocked-bg);color:var(--blocked-fg);font-weight:700}
.chip{display:inline-block;padding:0 5px;border:1px solid var(--line);border-radius:4px;font-size:10px;line-height:17px;color:var(--muted)}
a.chip{text-decoration:none}
a.chip:hover{background:var(--hover);border-color:var(--muted);color:var(--fg)}
.warn{color:var(--agent-fg);font-size:12px;margin-left:18px}
.reason{color:var(--blocked-fg);font-size:12px;margin-left:18px}
.rows{list-style:none;margin:5px 0 14px;padding:0}
.rows:last-child{margin-bottom:0}
.row{display:block;padding:8px;border-bottom:1px solid var(--line);border-radius:4px;cursor:pointer}
.row:last-child{border-bottom-color:transparent}
.row:hover{background:var(--hover)}
.row .line{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.row .title{font-weight:600}
.prs{color:var(--muted);font-size:11px}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px}
.board{display:flex;gap:10px;overflow-x:auto;padding:3px 3px 10px;scrollbar-color:var(--line) transparent;scrollbar-width:thin;align-items:stretch}
.col{flex:1 0 196px;min-width:196px;background:var(--bg);border:1px solid var(--line);border-radius:7px;padding:9px;min-height:132px;border-top:2px solid #849497}
.col.empty{flex:1 0 104px;min-width:104px}
.col:nth-child(3){border-top-color:#dbaa60}.col:nth-child(4){border-top-color:#739cce}
.col:nth-child(n+5){border-top-color:#74a391}.col:last-child{border-top-color:var(--accent)}
.col-head{display:flex;justify-content:space-between;gap:6px;align-items:center;margin-bottom:11px}
.col-head h3{font-size:10px;letter-spacing:.025em}
.count{color:var(--muted);font:10px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--panel);border:1px solid var(--line);border-radius:4px;min-width:19px;text-align:center;padding:1px 3px}
.empty-lane{display:block;text-align:center;color:var(--line);margin:23px 0;font-size:20px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:10px;margin-bottom:7px;cursor:pointer;box-shadow:var(--shadow);overflow-wrap:anywhere}
.card:last-child{margin-bottom:0}
.card:hover{border-color:var(--accent)}
.card .title{display:block;margin:4px 0 8px;font-weight:600;line-height:1.4}
.card .pr{color:var(--muted);font-size:10px;margin-top:7px;overflow-wrap:anywhere}
.card .warn{margin-left:0;font-size:11px;margin-top:6px}
.card .wt{font-style:normal}
.lines{list-style:none;margin:6px 0 0;padding:0}
.lines li{padding:5px 0;overflow-wrap:anywhere}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:1px 4px;overflow-wrap:anywhere}
.silo{font-weight:600}
.wt-row{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;padding:4px 0}
table.wt-table{border-collapse:collapse;width:100%;font-size:12px;margin-top:8px}
table.wt-table th{text-align:left;color:var(--muted);font-weight:500;border-bottom:1px solid var(--line)}
table.wt-table th,table.wt-table td{padding:7px 12px 7px 0;vertical-align:top;white-space:nowrap}
#housekeeping{overflow-x:auto}
#backdrop{position:fixed;inset:0;background:#081b2866;z-index:4}
#drawer{position:fixed;top:0;right:0;bottom:0;width:min(760px,100vw);z-index:5;overflow:auto;background:var(--panel);border-left:1px solid var(--line);padding:26px 24px 32px;box-shadow:-8px 0 40px #081b2822}
#drawer-close{position:absolute;top:16px;right:16px}
#drawer h2{font-size:21px;line-height:1.3;margin:0 36px 12px 0}
#drawer h3{margin:22px 0 8px;padding-top:14px;border-top:1px solid var(--line)}
#drawer table{border-collapse:collapse;width:100%;font-size:11px}
#drawer th{text-align:left;color:var(--muted);font-weight:500;border-bottom:1px solid var(--line)}
#drawer th,#drawer td{padding:6px 8px 6px 0;vertical-align:top;white-space:nowrap}
#drawer td:first-child{white-space:normal;min-width:120px;overflow-wrap:anywhere}
#drawer ul{margin:6px 0;padding-left:18px}
#drawer ul.flat{list-style:none;padding-left:0}
#drawer ul.flat li{padding:7px 0;border-bottom:1px solid var(--line)}
.box{font-family:ui-monospace,Menlo,monospace}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:22px}
.danger{color:var(--blocked-fg)}
#request-error{position:fixed;top:82px;left:24px;right:24px;z-index:10;margin:0;padding:12px;background:var(--panel);border:1px solid currentColor;border-radius:6px;white-space:pre-wrap}
#sync-health{padding:10px 14px;border:1px solid var(--line);border-radius:7px;background:var(--panel);font-size:12px}
#sync-health summary{cursor:pointer;color:var(--muted)}
#sync-health[open] summary{margin-bottom:8px;color:var(--fg)}
#next{border-top:2px solid var(--accent);background:var(--accent-soft)}
.next-moves{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:0;padding:0;list-style:none;counter-reset:moves}
.next-moves li{position:relative;counter-increment:moves;padding:14px 14px 12px 44px;border:1px solid var(--line);border-radius:7px;background:var(--panel);overflow-wrap:anywhere}
.next-moves li:before{content:"0" counter(moves);position:absolute;left:13px;top:16px;font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--accent)}
.next-moves .chip{display:block;width:fit-content;margin-bottom:5px}
.next-moves p{margin:7px 0;color:var(--muted);font-size:12px}
.next-moves button{padding:0;min-height:0;text-align:left;border:0;background:transparent;font-weight:650;line-height:1.4}
.next-moves button:hover:enabled{color:var(--accent);background:transparent;text-decoration:underline;text-underline-offset:3px}
.next-moves>li>a{font-weight:650}
.next-moves button+div{font-size:11px;margin-top:5px}
.action-reasons{margin:5px 0 0;padding-left:18px;color:var(--muted);font-size:11px}
footer{display:flex;justify-content:space-between;gap:12px;font-size:10px;padding:0 2px 8px;color:var(--accent)}
.skip-link{position:fixed;top:-60px;left:16px;z-index:20;padding:8px 14px;background:var(--panel);border:1px solid var(--accent);border-radius:5px}
.skip-link:focus{top:10px}
@media(min-width:1500px){main{padding:28px 32px}header.top{padding-left:32px;padding-right:32px}}
@media(max-width:900px){header.top{gap:12px}header.top nav{margin-left:0}#synced{display:none}.next-moves{gap:8px}.next-moves li{padding:12px}.next-moves li:before{position:static;float:right}.metrics{gap:12px}.metrics>div{padding-left:12px}}
@media(max-width:640px){header.top{padding:10px 14px;gap:10px;flex-wrap:wrap;min-height:64px}header.top nav{order:5;width:100%;border-top:1px solid #ffffff18;padding-top:4px}header.top nav a{padding:3px 10px}header.top select{max-width:135px;font-size:12px}.brand-icon,.brand-icon svg{width:30px;height:30px}.wordmark{font-size:16px}.wordmark small{display:none}main{padding:18px 12px;gap:12px}.overview{align-items:flex-start;flex-direction:column;gap:16px}h1{font-size:25px}.metrics{width:100%;gap:0}.metrics>div{flex:1;padding-left:14px}.metrics>div:first-child{padding-left:0;border:0}.metrics dd{font-size:22px}.next-moves{grid-template-columns:1fr}.next-moves li{padding:12px 12px 12px 43px}.next-moves li:before{position:absolute;float:none;top:14px}.next-moves .chip{display:inline-block;margin-right:6px}section{padding:13px;scroll-margin-top:118px}.section-heading>.muted{font-size:10px}#drawer{padding:22px 16px}#request-error{top:110px;left:12px;right:12px}footer{flex-wrap:wrap}}
`;
