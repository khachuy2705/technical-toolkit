// Marvel and DC superhero names — the project's own list, for the username
// generator.
//
// One hero per line, written as its words in Title Case: Spider-Man is
// "Spider Man", Ms. Marvel is "Ms Marvel". The words are what let a username
// be written joined or spaced, so hyphens and full stops are dropped here
// rather than at every call. Heroes and the heroic side of the antiheroes;
// no villains. Codenames only — never a civilian name.
//
// scripts/verify-tools.ts holds the rules an edit must keep: every word is
// [A-Z][a-z]+, no name repeats within or across the two lists once lowercased
// and joined, and each list stays at or above the bulk panel's maximum.

function lines(raw: string): readonly string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export const MARVEL_HEROES: readonly string[] = lines(`
  Adam Warlock
  Angel
  Ant Man
  Archangel
  Armor
  Aurora
  Banshee
  Beast
  Beta Ray Bill
  Bishop
  Black Bolt
  Black Knight
  Black Panther
  Black Widow
  Blade
  Blue Marvel
  Boom Boom
  Cable
  Cannonball
  Captain America
  Captain Britain
  Captain Marvel
  Captain Universe
  Cloak
  Colossus
  Crystal
  Cyclops
  Cypher
  Dagger
  Daredevil
  Darkhawk
  Dazzler
  Deadpool
  Deathlok
  Doctor Strange
  Doctor Voodoo
  Domino
  Drax
  Echo
  Elektra
  Falcon
  Firestar
  Forge
  Gambit
  Gamora
  Ghost Rider
  Ghost Spider
  Giant Man
  Goliath
  Gorgon
  Groot
  Havok
  Heimdall
  Hellcat
  Hercules
  Hulk
  Hulkling
  Human Torch
  Hyperion
  Iceman
  Invisible Woman
  Iron Fist
  Iron Man
  Ironheart
  Jocasta
  Jubilee
  Justice
  Karma
  Karnak
  Longshot
  Machine Man
  Magik
  Mantis
  Medusa
  Mirage
  Miss America
  Mister Fantastic
  Mockingbird
  Moon Girl
  Moon Knight
  Moondragon
  Ms Marvel
  Multiple Man
  Night Thrasher
  Nightcrawler
  Nighthawk
  Nomad
  Northstar
  Nova
  Patriot
  Phoenix
  Pixie
  Polaris
  Power Man
  Psylocke
  Puck
  Punisher
  Quake
  Quasar
  Quicksilver
  Rictor
  Rocket
  Rogue
  Sage
  Sasquatch
  Scarlet Spider
  Scarlet Witch
  Sentry
  Sersi
  Shadowcat
  Shaman
  Shang Chi
  Shatterstar
  She Hulk
  Sif
  Silk
  Silver Surfer
  Siryn
  Snowbird
  Songbird
  Spectrum
  Speedball
  Spider Girl
  Spider Man
  Spider Woman
  Squirrel Girl
  Star Lord
  Starfox
  Stature
  Storm
  Strong Guy
  Sunspot
  Thing
  Thor
  Thunderbird
  Thunderstrike
  Tigra
  Union Jack
  Valkyrie
  Vision
  War Machine
  Warpath
  Wasp
  White Tiger
  Wiccan
  Winter Soldier
  Wolfsbane
  Wolverine
  Wonder Man
  Yellowjacket
`);

export const DC_HEROES: readonly string[] = lines(`
  Adam Strange
  Animal Man
  Aquagirl
  Aqualad
  Aquaman
  Arsenal
  Atom
  Atom Smasher
  Azrael
  Batgirl
  Batman
  Batwing
  Batwoman
  Beast Boy
  Big Barda
  Black Canary
  Black Condor
  Black Lightning
  Black Orchid
  Blue Beetle
  Blue Devil
  Bluebird
  Booster Gold
  Bronze Tiger
  Bumblebee
  Captain Atom
  Captain Comet
  Commander Steel
  Cosmic Boy
  Crimson Avenger
  Cyborg
  Cyclone
  Damage
  Dawnstar
  Deadman
  Doctor Fate
  Doctor Occult
  Doll Man
  Dove
  Element Lad
  Elongated Man
  Fire
  Firehawk
  Firestorm
  Flash
  Geo Force
  Green Arrow
  Green Lantern
  Guardian
  Gypsy
  Halo
  Hawk
  Hawkgirl
  Hawkman
  Hourman
  Human Bomb
  Huntress
  Ice
  Impulse
  Jade
  Jericho
  Jesse Quick
  Katana
  Kid Eternity
  Kid Flash
  Kilowog
  Liberty Belle
  Lightning
  Lightning Lad
  Lightray
  Madame Xanadu
  Manhunter
  Martian Manhunter
  Max Mercury
  Mera
  Metamorpho
  Miss Martian
  Mister Miracle
  Mister Terrific
  Mon El
  Nightwing
  Obsidian
  Oracle
  Orion
  Phantom Lady
  Phantom Stranger
  Plastic Man
  Power Girl
  Question
  Ragman
  Raven
  Red Arrow
  Red Hood
  Red Robin
  Red Tornado
  Robin
  Saint Walker
  Sandman
  Saturn Girl
  Shadow Lass
  Shazam
  Signal
  Spectre
  Speedy
  Spoiler
  Star Boy
  Starfire
  Stargirl
  Starman
  Static
  Steel
  Superboy
  Supergirl
  Superman
  Swamp Thing
  Tempest
  Thunder
  Timber Wolf
  Troia
  Ultra Boy
  Uncle Sam
  Vigilante
  Vixen
  Wildcat
  Wildfire
  Wonder Girl
  Wonder Woman
  Zatanna
`);
