// Superhero wordlist (101 words) — the project's own list.
//
// Generated from superhero.txt in this directory. To change the words, edit
// that file and regenerate:
//
//   cut -f1 src/lib/wordlists/superhero.txt | tr '\n' ' '
//
// Stored as one space-delimited string, matching the EFF list modules.
const RAW =
  "superman batman spiderman ironman thor hulk wolverine deadpool daredevil punisher aquaman flash cyborg nightwing robin supergirl batgirl starfire raven beastboy hawkeye falcon warpath cyclops gambit colossus iceman storm rogue psylocke jubilee bishop cable domino elektra blade moonknight ghostrider antman wasp vision quicksilver starlord groot rocket drax gamora nebula mantis shazam blackadam greenarrow superboy bluebeetle firestorm atom spectre constantine hellboy spawn invincible omniman atomiceve homelander starlight blacknoir aqualad speedy redhood huntress powergirl hawkgirl hawkman zatanna vixen metamorpho steel booster vigilante wildcat guardian sentry nova quasar warlock sunspot magik nightcrawler havok polaris forge banshee longshot strongguy warlocke firestar darkhawk cloak dagger hyperion gladiator";

export const SUPERHERO: readonly string[] = RAW.split(" ");
