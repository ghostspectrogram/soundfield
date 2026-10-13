// Sorting sounds into categories. The list follows the top-level categories
// of the UCS (Universal Category System) as used by Epidemic Sound, plus
// Background (ambiences), Room tone and Voice.
//
// metaCategory() uses names and metadata only (instant). analyzeFeatures()
// + classifyFeatures() listen to the audio for files whose names say nothing;
// listening can tell background / room tone / voice / footsteps / musical.

// Bump when the listening rules change so cached results get redone.
export const ANALYSIS_VERSION = 4;

const w = (...words) => new RegExp(`\\b(${words.join('|')})\\b`);

// [id, label, UCS CatID prefixes, keyword pattern]. Keyword rules are tried in
// this order, so specific things ("car door") come before materials ("wood").
const DEFS = [
  ['roomtone', 'Room tone', [], w('room ?tones?', 'roomtone', 'air ?tones?', 'fill ?tones?')],
  ['background', 'Background', ['AMB', 'ATMS'], w('ambiences?', 'ambiances?', 'ambient', 'amb', 'atmos', 'atmospheres?', 'backgrounds?', 'bgs?', 'soundscapes?', 'environments?')],
  ['crowds', 'Crowds', ['CROWD', 'CRWD', 'CRWDS'], w('crowds?', 'walla', 'applause', 'clapping', 'cheer(s|ing)?', 'audiences?', 'spectators?', 'protests?', 'loop group')],
  ['footsteps', 'Footsteps', ['FEET', 'FOOT', 'FTSTP'], w('foot ?steps?', 'steps?', 'walk(s|ing|ed)?', 'jog(s|ging)?', 'sprint(s|ing)?', 'shuffl(e|es|ing)', 'stomp(s|ing)?', 'treads?', 'pacing', 'strides?', 'gallop(s|ing)?', 'trot(s|ting)?', 'march(es|ing)?')],
  ['voice', 'Voice', ['VOX', 'VOC', 'DIAL', 'VOICE'], w('voices?', 'vocals?', 'vox', 'vo', 'voiceovers?', 'voice ?over', 'dialog(ue)?s?', 'speech', 'speak(s|ing)?', 'spoken', 'talk(s|ing)?', 'conversations?', 'narrat(or|ion|es|ing)', 'announc(er|ement)s?', 'whisper(s|ing|ed)?', 'shout(s|ing|ed)?', 'scream(s|ing|ed)?', 'yell(s|ing|ed)?', 'laugh(s|ing|ter)?', 'giggl(e|es|ing)', 'crying', 'sobs?', 'sobbing', 'grunts?', 'efforts?', 'exertions?', 'moans?', 'groans?', 'pant(s|ing)', 'chants?', 'adr', 'wild ?lines?', 'babbl(e|ing)', 'babies', 'baby', 'one ?words?', 'acapellas?', 'a ?cappellas?')],
  ['human', 'Human', ['HUMN', 'HMN', 'HUM'], w('breath(s|ing)?', 'breathe', 'inhal(e|es|ing)', 'exhal(e|es|ing)', 'gasps?', 'coughs?', 'coughing', 'sneez(e|es|ing)', 'sniff(s|ing)?', 'snor(e|es|ing)', 'burps?', 'belch(es|ing)?', 'hiccups?', 'spit(s|ting)?', 'vomit(s|ing)?', 'puk(e|ing)', 'heart ?beats?', 'kiss(es|ing)?', 'peeing', 'urinat(e|ing)', 'gulps?', 'swallow(s|ing)?', 'sighs?', 'finger ?snaps?', 'yawns?')],
  // Words that only ever mean music. Instrument names come much later (see below), so a
  // "Cymbal Whoosh" is a whoosh and a "Magic Choir" is magic.
  ['musical', 'Musical', ['MUSC', 'MUS', 'MUSIC'], w('music', 'musical', 'songs?', 'singing', 'sung', 'instrumental', 'soundtrack', 'melody', 'stems', '\\d{2,3} ?bpm', 'bpm', 'orchestra(l)?', 'chords?', 'chord ?progressions?', 'arpeggios?', 'music ?box', 'riffs?', 'grooves?')],
  ['swooshes', 'Swooshes', ['WHSH', 'SWSH', 'SWOOSH', 'WHOOSH'], w('whoosh(es)?', 'swoosh(es)?', 'swish(es)?', 'swoops?', 'swipes?', 'woosh(es)?')],
  ['designed', 'Designed', ['DSGN', 'DESN', 'DESIGN'], w('designed', 'risers?', 'braams?', 'stingers?', 'sub ?drops?', 'trailer', 'cinematic', 'transitions?', 'morph(s|ing)?', 'granular', 'reversed?', 'downers?', 'uplifters?', 'bass ?drops?')],
  ['fireworks', 'Fireworks', ['FWRK', 'FIREWK', 'FRWK', 'FIRWK'], w('fireworks?', 'firecrackers?', 'sparklers?')],
  ['explosions', 'Explosions', ['EXPL', 'EXPLO'], w('explosions?', 'explod(e|es|ing)', 'blasts?', 'detonat(e|es|ion|ions)', 'bombs?', 'grenades?', 'kaboom', 'dynamite')],
  ['lasers', 'Lasers', ['LASR', 'LASER'], w('lasers?', 'phasers?', 'blasters?', 'ray ?guns?')],
  ['tools', 'Tools', ['TOOL', 'TOOLS'], w('tools?', 'drills?', 'drilling', 'saws?', 'sawing', 'chainsaws?', 'hammer(s|ing)?', 'wrench(es)?', 'screwdrivers?', 'sanders?', 'sanding', 'grinders?', 'grinding', 'nail ?guns?', 'jackhammers?', 'pliers', 'chisel(s|ing)?', 'rakes?', 'raking', 'lawn ?mowers?', 'leaf ?blowers?', 'hedge ?trimmers?', 'staple ?guns?', 'power ?tools?')],
  ['guns', 'Guns', ['GUN', 'GUNS'], w('guns?', 'gunshots?', 'gun ?fire', 'gunfire', 'rifles?', 'pistols?', 'shotguns?', 'revolvers?', 'machine ?guns?', 'reload(s|ing)?', 'snipers?', 'ak ?47', 'uzi', 'firearms?', 'silenced', 'suppressed', 'suppressors?', 'cannons?', 'artillery', 'mortars?', 'muzzle')],
  ['bullets', 'Bullets', ['BLLT', 'BULT', 'BULLET'], w('bullets?', 'ricochets?', 'whiz ?bys?', 'bullet ?bys?', 'shell ?casings?', 'casings?')],
  ['weapons', 'Weapons', ['WEAP', 'WPN'], w('swords?', 'knif(e|es)', 'axes?', 'arrows?', 'blades?', 'whips?', 'maces?', 'spears?', 'daggers?', 'unsheath(e|es|ing)', 'sheath(e|es|ing)?', 'katanas?', 'armou?r', 'crossbows?', 'shields?', 'polearms?', 'catapults?', 'trebuchets?')],
  ['fight', 'Fight', ['FGHT', 'FIGHT'], w('punch(es|ing)?', 'kicks?', 'kicking', 'body ?falls?', 'bodyfalls?', 'slaps?', 'slapping', 'fights?', 'fighting', 'grabs?', 'tackles?', 'brawls?', 'body ?hits?', 'martial')],
  ['scifi', 'Scifi', ['SCI', 'SCIFI'], w('sci ?fi', 'scifi', 'spaceships?', 'space ?ships?', 'starships?', 'teleport(s|er|ing)?', 'futuristic', 'holograms?', 'force ?fields?', 'warp(s|ing)?', 'tractor ?beam')],
  ['robots', 'Robots', ['ROBO', 'ROBT', 'ROBOT'], w('robots?', 'robotic', 'droids?', 'cyborgs?', 'androids?', 'mechs?')],
  ['magic', 'Magic', ['MAGC', 'MAGI', 'MAGIC'], w('magic(al)?', 'spells?', 'shimmers?', 'sparkl(e|es|y)', 'fair(y|ies)', 'enchant(ed|ment|ing)?', 'wands?', 'potions?', 'curses?', 'mystic(al)?', 'poof')],
  ['creatures', 'Creatures', ['CREA', 'CRTR', 'CREAT'], w('creatures?', 'monsters?', 'dragons?', 'zombies?', 'beasts?', 'demons?', 'ghouls?', 'ghosts?', 'trolls?', 'orcs?', 'goblins?', 'aliens?', 'werewol(f|ves)', 'dinosaurs?', 'kaiju', 'spirits?')],
  ['cartoon', 'Cartoon', ['TOON', 'CART', 'CRTN'], w('cartoons?', 'toon', 'boings?', 'slide ?whistles?', 'comedic', 'comedy', 'goofy', 'zany', 'wacky', 'looney', 'kazoo')],
  ['gore', 'Gore', ['GORE'], w('gore', 'gory', 'blood(y)?', 'flesh', 'guts', 'bone ?(breaks?|cracks?|snaps?)', 'squish(es|y|ing)?', 'stabs?', 'stabbing', 'dismember(ment)?', 'decapitat(e|ion)', 'splatter')],
  ['vehicles', 'Vehicles', ['VEH', 'VEHI'], w('cars?', 'vehicles?', 'trucks?', 'engines?', 'motorcycles?', 'motorbikes?', 'bikes?', 'bicycles?', 'bus(es)?', 'vans?', 'suvs?', 'tires?', 'tyres?', 'skids?', 'brakes?', 'braking', 'jeeps?', 'tractors?', 'atvs?', 'racing', 'race ?cars?', 'drive ?bys?', 'pass ?bys?', 'revs?', 'revving', 'ignition', 'exhaust', 'honk(s|ing)?', 'wagons?', 'carriages?', 'scooters?', 'ambulances?', 'police ?cars?', 'fire ?trucks?', 'forklifts?', 'limousines?', 'taxis?', 'tanks? (tread|engine|drive)')],
  ['aircraft', 'Aircraft', ['AERO', 'AIRC', 'ACFT', 'AIRCR', 'PLANE'], w('aircraft', 'airplanes?', 'aeroplanes?', 'planes?', 'jets?', 'helicopters?', 'heli', 'choppers?', 'rockets?', 'missiles?', 'drones?', 'propellers?', 'airliners?', 'gliders?', 'blimps?', 'zeppelins?', 'take ?offs?', 'landing ?gear', 'fly ?bys?', 'flybys?')],
  ['trains', 'Trains', ['TRN', 'TRAIN', 'TRAN'], w('trains?', 'subways?', 'trams?', 'metros?', 'railways?', 'railroads?', 'locomotives?', 'rails?', 'freight', 'carriages? clack', 'monorail')],
  ['boats', 'Boats', ['BOAT', 'SHIP'], w('boats?', 'ships?', 'sail(s|boats?|ing)?', 'yachts?', 'ferr(y|ies)', 'submarines?', 'canoes?', 'kayaks?', 'rowboats?', 'rowing', 'oars?', 'motorboats?', 'jet ?skis?', 'hull', 'bow ?wash', 'outboard')],
  ['communications', 'Communications', ['COMM', 'COMS'], w('phones?', 'telephones?', 'cell ?phones?', 'smartphones?', 'ringtones?', 'radios?', 'tv', 'televisions?', 'static', 'cameras?', 'camera ?shutters?', 'microphones?', 'mic', 'typewriters?', 'walkie ?talkies?', 'intercoms?', 'morse', 'dial ?tones?', 'fax', 'modems?', 'vinyl', 'record ?players?', 'phonographs?', 'tape ?recorders?', 'cassettes?', 'transceivers?', 'telemetry')],
  ['computers', 'Computers', ['COMP', 'COMPU', 'CMPTR'], w('computers?', 'keyboards?', 'typing', 'mouse', 'mice clicks?', 'hard ?drives?', 'laptops?', 'pcs?', 'servers?', 'disk ?drives?', 'floppy')],
  ['ui', 'User Interface', ['UI', 'USER', 'GUI'], w('ui', 'user ?interface', 'interface', 'buttons?', 'menus?', 'notifications?', 'alerts?', 'hover', 'selects?', 'confirm(ation)?', 'cancel', 'pop ?ups?', 'hud', 'toggles?', 'app')],
  ['beeps', 'Beeps', ['BEEP'], w('beeps?', 'beeping', 'bleeps?', 'blips?')],
  ['alarms', 'Alarms', ['ALRM', 'ALARM'], w('alarms?', 'sirens?', 'buzzers?', 'smoke ?detectors?', 'klaxons?')],
  ['bells', 'Bells', ['BELL', 'BELLS'], w('bells?', 'gongs?', 'chimes?', 'doorbells?', 'handbells?')],
  ['clocks', 'Clocks', ['CLOCK', 'CLOK', 'CLCK'], w('clocks?', 'tick(s|ing)?', 'tock', 'cuckoo', 'grandfather ?clock', 'stopwatch', 'wristwatch')],
  ['horns', 'Horns', ['HORN', 'HORNS'], w('horns?', 'foghorns?', 'air ?horns?', 'vuvuzelas?')],
  ['whistles', 'Whistles', ['WHSTL', 'WHIS', 'WHST', 'WHISTL'], w('whistl(e|es|ing)')],
  ['toys', 'Toys', ['TOY', 'TOYS'], w('toys?', 'baby ?rattles?', 'wind ?ups?', 'jack ?in ?the ?box', 'squeaky ?toys?', 'teddy', 'yo ?yo', 'spinning ?tops?', 'rubber ?duck')],
  ['games', 'Games', ['GAME', 'GAMES'], w('games?', 'gaming', 'arcade', 'casino', 'slot ?machines?', 'dice', 'playing ?cards?', 'card ?shuffle', 'chess', 'board ?games?', 'pinball', '8 ?bit', 'chiptune', 'video ?games?', 'poker ?chips?', 'roulette')],
  ['sports', 'Sports', ['SPRT', 'SPORT', 'SPRTS'], w('sports?', 'balls?', 'basketball', 'football', 'soccer', 'tennis', 'golf', 'baseball', 'hockey', 'skate(board|boarding|s)?', 'bowling', 'ping ?pong', 'volleyball', 'rugby', 'boxing', 'gym', 'dumbbells?', 'barbells?', 'treadmills?', 'ski(s|ing)?', 'surfboards?', 'rackets?', 'snowboard(ing)?', 'archery', 'referee')],
  ['equipment', 'Equipment', ['GEAR', 'EQUIP', 'EQPT'], w('equipment', 'gear', 'tactical', 'saddles?', 'bridles?', 'harness(es)?', 'tents?', 'camping', 'carabiners?', 'scuba', 'parachutes?', 'climbing ?gear', 'holsters?')],
  // Instruments: after the sound effect categories, before nature and materials.
  ['musical', null, [], w('guitars?', 'pianos?', 'drums?', 'drum ?kits?', 'violins?', 'cellos?', 'synths?', 'synthesizers?', 'flutes?', 'trumpets?', 'trombones?', 'sax(ophone)?', 'harps?', 'choirs?', 'percussion', 'cymbals?', 'snares?', 'kick ?drums?', 'hi ?hats?', 'marimba', 'xylophone', 'ukulele', 'banjo', 'organ', 'accordion', 'harmonica', 'beats?', 'basslines?')],
  ['rain', 'Rain', ['RAIN'], w('rain(s|ing|y|fall)?', 'drizzl(e|ing)', 'downpours?', 'raindrops?')],
  ['weather', 'Weather', ['WTHR', 'WEATH', 'WETH'], w('thunder(storms?|claps?)?', 'storms?', 'stormy', 'hail(storm)?', 'lightning', 'blizzards?', 'weather')],
  ['wind', 'Wind', ['WIND'], w('winds?', 'windy', 'gusts?', 'gusty', 'breezes?', 'breezy', 'gales?')],
  ['snow', 'Snow', ['SNOW'], w('snow(y|ball|balls|fall)?', 'slush', 'sleighs?')],
  ['ice', 'Ice', ['ICE'], w('ice', 'icy', 'icicles?', 'frozen', 'ice ?cubes?', 'freez(e|es|ing)', 'glacier')],
  ['fire', 'Fire', ['FIRE'], w('fires?', 'flames?', 'burn(s|ing)?', 'torch(es)?', 'crackl(e|es|ing)', 'campfires?', 'bonfires?', 'lighters?', 'match ?strikes?', 'matches', 'blaze', 'inferno', 'flamethrowers?', 'fireplace', 'ignit(e|es|ion)')],
  ['geothermal', 'Geothermal', ['GEOT', 'GEO', 'GEOTH'], w('lava', 'geysers?', 'magma', 'volcan(o|oes|ic)', 'hot ?springs?', 'fumaroles?', 'mud ?pots?')],
  ['disaster', 'Natural Disaster', ['NATDIS', 'NTRL', 'DSTR', 'NATR'], w('earthquakes?', 'avalanches?', 'tornado(es)?', 'tsunamis?', 'landslides?', 'hurricanes?', 'rockfalls?')],
  ['water', 'Water', ['WATR', 'WATER', 'WTR'], w('water', 'watery', 'splash(es|ing)?', 'drips?', 'dripping', 'streams?', 'rivers?', 'creeks?', 'brooks?', 'waterfalls?', 'waves?', 'surf', 'ocean', 'seas?', 'lakes?', 'bubbl(e|es|ing|y)', 'faucets?', 'taps?', 'sinks?', 'toilets?', 'flush(es|ing)?', 'showers?', 'bath(tub)?s?', 'puddles?', 'underwater', 'hydrophone', 'fountains?', 'gurgl(e|es|ing)', 'drains?', 'plumbing', 'sprays?', 'spraying', 'hose')],
  ['doors', 'Doors', ['DOOR', 'DOORS'], w('doors?', 'gates?', 'door ?knobs?', 'door ?handles?', 'hinges?', 'knock(s|ing)?', 'garage ?doors?', 'screen ?doors?', 'cabinets?', 'cupboards?', 'lockers?', 'hatch(es)?')],
  ['drawers', 'Drawers', ['DRWR', 'DRAW', 'DRAWR'], w('drawers?')],
  ['windows', 'Windows', ['WNDW', 'WINDW', 'WNDO'], w('windows?', 'window ?blinds?', 'blinds', 'shutters?', 'curtains?')],
  ['food', 'Food & Drink', ['FOOD', 'FOOD'], w('food', 'eat(s|ing)?', 'chew(s|ing)?', 'bites?', 'biting', 'crunch(es|ing|y)?', 'drink(s|ing)?', 'sips?', 'sipping', 'cook(s|ing)?', 'fry(ing)?', 'frying', 'sizzl(e|es|ing)', 'kitchen', 'cutlery', 'plates?', 'cups?', 'mugs?', 'soda', 'beer', 'coffee', 'tea', 'wine', 'cereal', 'chips', 'apples?', 'chopp(ing|ed)?', 'bowls?', 'utensils?', 'forks?', 'spoons?', 'pans?', 'pots?', 'kettles?', 'toaster', 'blender', 'dining', 'restaurant')],
  ['glass', 'Glass', ['GLAS', 'GLASS'], w('glass(es)?', 'shatter(s|ing|ed)?', 'bottles?', 'jars?', 'windshields?', 'goblets?')],
  ['ceramics', 'Ceramics', ['CERM', 'CERA', 'CRMC'], w('ceramics?', 'porcelain', 'pottery', 'clay', 'tiles?', 'crockery', 'vases?')],
  ['liquid', 'Liquid & Mud', ['LIQ', 'MUD', 'LIQD'], w('mud(dy)?', 'slime', 'slimy', 'goo', 'gooey', 'liquids?', 'squelch(es|y|ing)?', 'sludge', 'ooze', 'oozing', 'viscous', 'suction ?cups?')],
  ['chemicals', 'Chemicals', ['CHEM'], w('chemicals?', 'chemistry', 'acid(ic)?', 'reactions?', 'fizz(es|ing|y)?', 'dissolv(e|es|ing)', 'corrosive', 'beakers?', 'laboratory', 'test ?tubes?', 'effervesc(e|ent|ing)')],
  ['machines', 'Machines', ['MACH', 'MCHN'], w('machines?', 'machinery', 'fans?', 'hvac', 'air ?condition(er|ers|ing)?', 'elevators?', 'lifts?', 'escalators?', 'printers?', 'washing ?machines?', 'dishwashers?', 'vacuum(s| cleaners?)?', 'pumps?', 'generators?', 'compressors?', 'appliances?', 'refrigerators?', 'fridges?', 'microwaves?', 'conveyors?', 'factory', 'industrial', 'vending', 'photocopiers?', 'dryers?')],
  ['motors', 'Motors', ['MOTR', 'MOTOR'], w('motors?', 'servos?', 'turbines?', 'actuators?')],
  ['mechanical', 'Mechanical', ['MECH', 'MECHN'], w('mechanical', 'mechanisms?', 'switch(es)?', 'latch(es)?', 'levers?', 'locks?', 'unlock(s|ing)?', 'ratchets?', 'gears?', 'cogs?', 'relays?', 'pulleys?', 'clicks?', 'clicking', 'hydraulics?', 'pneumatics?', 'springs?', 'rollers?', 'winch(es)?', 'cranks?', 'clockwork')],
  ['electricity', 'Electricity', ['ELEC', 'ELCT'], w('electric(al|ity)?', 'sparks?', 'sparking', 'zaps?', 'arcs?', 'arcing', 'buzz(es|ing)?', 'hum(s|ming)?', 'tesla', 'power ?lines?', 'transformers?', 'short ?circuits?', 'tasers?', 'electrocut(e|ion)', 'neon')],
  ['birds', 'Birds', ['BIRD', 'BIRDS'], w('birds?', 'birdsong', 'chirp(s|ing)?', 'tweet(s|ing)?', 'crows?', 'ravens?', 'seagulls?', 'gulls?', 'owls?', 'chickens?', 'hens?', 'roosters?', 'ducks?', 'geese', 'goose', 'parrots?', 'pigeons?', 'doves?', 'eagles?', 'hawks?', 'sparrows?', 'robins?', 'woodpeckers?', 'peacocks?', 'turkeys?', 'songbirds?', 'magpies?', 'vultures?', 'loons?')],
  ['wings', 'Wings', ['WING', 'WINGS'], w('wings?', 'wing ?flaps?', 'flapping', 'flaps?')],
  ['animals', 'Animals', ['ANML', 'ANIM', 'ANMLS'], w('animals?', 'dogs?', 'barks?', 'barking', 'pupp(y|ies)', 'cats?', 'meows?', 'kittens?', 'purr(s|ing)?', 'cows?', 'moo(s|ing)?', 'horses?', 'neigh(s|ing)?', 'pigs?', 'oinks?', 'sheep', 'goats?', 'lions?', 'tigers?', 'bears?', 'wol(f|ves)', 'howl(s|ing)?', 'monkeys?', 'apes?', 'frogs?', 'toads?', 'insects?', 'bees?', 'flies', 'mosquito(es)?', 'crickets?', 'cicadas?', 'snakes?', 'rattlesnakes?', 'elephants?', 'whales?', 'dolphins?', 'seals?', 'rats?', 'mice', 'squirrels?', 'deer', 'fox(es)?', 'donkeys?', 'camels?', 'growl(s|ing)?', 'roar(s|ing)?', 'squeal(s|ing)?', 'bats?')],
  ['paper', 'Paper', ['PAPR', 'PAPER'], w('paper', 'papers', 'cardboard', 'pages?', 'newspapers?', 'magazines?', 'notebooks?', 'tissues?', 'crumpl(e|es|ing)', 'envelopes?', 'flutter(s|ing)?')],
  ['plastic', 'Plastic', ['PLAS', 'PLST', 'PLSTC'], w('plastic', 'pvc', 'acrylic', 'polystyrene', 'styrofoam', 'bubble ?wrap')],
  ['cloth', 'Cloth', ['CLOTH', 'CLTH'], w('cloth', 'cloths', 'fabric', 'clothing', 'clothes', 'jackets?', 'coats?', 'shirts?', 'pants', 'trousers', 'jeans', 'dress(es)?', 'sheets?', 'blankets?', 'towels?', 'flags?', 'canvas', 'tarps?', 'denim', 'silk', 'wool')],
  ['leather', 'Leather', ['LETH', 'LEATH', 'LTHR'], w('leather', 'belts?')],
  ['rubber', 'Rubber', ['RUBR', 'RBBR', 'RUBB'], w('rubber', 'balloons?', 'latex', 'elastic', 'rubber ?bands?', 'squeegees?')],
  ['rope', 'Rope', ['ROPE'], w('ropes?', 'cords?', 'twine', 'lasso', 'knots?', 'rigging')],
  ['chains', 'Chains', ['CHAIN', 'CHN', 'CHAINS'], w('chains?', 'chainlink', 'shackles?', 'manacles?')],
  ['rocks', 'Rocks', ['ROCK', 'ROCKS'], w('rocks?', 'stones?', 'gravel', 'pebbles?', 'boulders?', 'concrete', 'bricks?', 'marble', 'cobblestones?', 'rubble')],
  ['dirt', 'Dirt & Sand', ['DIRT', 'SAND'], w('dirt', 'sand', 'sandy', 'soil', 'dig(s|ging)?', 'shovel(s|ing)?', 'dust', 'dusty')],
  ['vegetation', 'Vegetation', ['VEG', 'VEGE', 'VEGT'], w('grass', 'leaves', 'leaf', 'bush(es)?', 'branch(es)?', 'trees?', 'foliage', 'twigs?', 'plants?', 'reeds?', 'corn', 'hay', 'bamboo', 'vines?', 'flowers?', 'undergrowth', 'shrubs?', 'hedges?')],
  ['wood', 'Wood', ['WOOD'], w('wood', 'wooden', 'timber', 'planks?', 'logs?', 'sticks?', 'boards?', 'creak(s|ing|y)?', 'splinter(s|ing)?', 'lumber', 'crates?')],
  ['metal', 'Metal', ['METL', 'METAL', 'MTL'], w('metal', 'metallic', 'clang(s|ing)?', 'steel', 'iron', 'tin', 'alumin(um|ium)', 'copper', 'brass', 'sheet ?metal', 'pipes?', 'anvils?', 'girders?')],
  ['destruction', 'Destruction', ['DEST', 'DSTRC'], w('destruction', 'debris', 'collaps(e|es|ing)', 'demolition', 'demolish(ing)?', 'crumbl(e|es|ing)', 'smash(es|ing)?', 'crash(es|ing)?', 'wreck(age|ing)?', 'break(s|ing)?', 'broken')],
  ['objects', 'Objects', ['OBJ', 'OBJT', 'OBJCT'], w('objects?', 'bags?', 'books?', 'coins?', 'containers?', 'box(es)?', 'furniture', 'chairs?', 'tables?', 'sofas?', 'couch(es)?', 'beds?', 'keys?', 'keychains?', 'zippers?', 'umbrellas?', 'luggage', 'suitcases?', 'wallets?', 'purses?', 'jewel(le)?ry', 'necklaces?', 'bracelets?', 'rings?', 'pens?', 'pencils?', 'markers?', 'writing', 'scissors', 'staplers?', 'tape', 'packaging', 'household', 'hangers?', 'brooms?', 'mops?', 'buckets?', 'lamps?', 'candles?', 'mirrors?', 'combs?', 'brushes?', 'toothbrush(es)?', 'razors?', 'shopping ?carts?', 'trolleys?', 'wheelchairs?', 'strollers?', 'backpacks?', 'handbags?', 'pillows?', 'cushions?', 'shoes?', 'glasses ?case', 'remote ?control')],
  ['movement', 'Movement', ['MOVE', 'MOVM'], w('movements?', 'moves?', 'moving', 'rustl(e|es|ing)', 'handling', 'foley', 'activity', 'fidget(s|ing)?', 'presence', 'body ?moves?', 'crawl(s|ing)?', 'climb(s|ing)?')],
  ['air', 'Air', ['AIR'], w('air', 'blow(s|ing)?', 'bursts?', 'hiss(es|ing)?', 'suction', 'pressure ?release', 'compressed ?air', 'airlocks?', 'puffs?', 'inflat(e|es|ing|ion)', 'deflat(e|es|ing|ion)', 'vents?', 'venting')],
  // Generic hits with nothing else to go on are treated as designed impacts.
  ['designed', null, [], w('impacts?', 'hits?', 'booms?', 'thuds?', 'thumps?', 'bangs?', 'slams?', 'drones?', 'rumbles?', 'sweeps?', 'glitch(es|y)?', 'stutter', 'tonal')],
];

export const TYPE_LABELS = { unsorted: 'Unsorted' };
const UCS = {};
const RULES = [];
for (const [id, label, prefixes, re] of DEFS) {
  if (label) TYPE_LABELS[id] = label;
  for (const p of prefixes) UCS[p] = id;
  if (re) RULES.push([id, re]);
}
// Every category (sorted by label) plus the ones the listener can produce.
export const TYPES = Object.keys(TYPE_LABELS).filter(k => k !== 'unsorted').sort((a, b) => TYPE_LABELS[a].localeCompare(TYPE_LABELS[b]));

// UCS (Universal Category System) file names start with a CatID such as
// "AMBForst_" or "DOORWood_": an upper-case category plus a sub-category.
export function ucsCategory(file) {
  const m = file.match(/^([A-Z]{2,6}?)([A-Z][a-z][A-Za-z]*)?_/);
  return m ? { cat: m[1], sub: m[2] || '' } : null;
}

// "run" / "jump" only count as footsteps when it's not an engine running, a tap running, etc.
const RE_RUN = w('run(s|ning)?', 'jump(s|ing)?', 'landings?');
const RE_NOT_BODY = w('engines?', 'motors?', 'cars?', 'vehicles?', 'trucks?', 'machines?', 'machinery', 'fans?', 'generators?', 'water', 'taps?', 'faucets?', 'streams?', 'rivers?', 'sinks?', 'ramps?', 'projectors?', 'servos?', 'computers?', 'press', 'trains?');
// Words that make voice / human words mean something else ("Tire Scream", "Steam Valve Breath").
const RE_NOT_VOICE = w('engines?', 'motors?', 'machines?', 'tires?', 'tyres?', 'brakes?', 'metal', 'birds?', 'animals?', 'dogs?', 'cats?', 'horses?', 'wind', 'valves?', 'steam', 'creatures?', 'monsters?');

// Epidemic Sound tracks are saved as "ES_<title> - <artist>"; their sound effects as
// "ES_<title> - Epidemic Sound" (or "- SFX Producer").
const RE_ES_TRACK = /^ES_.+ - (.+?)( \(\d+\))?(?: \d{4,6} \d+)?\.[^.]+$/;
export const isEpidemicFile = file => /^ES_/.test(file);

export function metaCategory(rel, desc) {
  const file = rel.slice(rel.lastIndexOf('/') + 1);
  const es = RE_ES_TRACK.exec(file);
  if (es && !/epidemic sound|sfx producer/i.test(es[1])) return 'musical';
  const ucs = ucsCategory(file);
  if (ucs) {
    if (ucs.cat === 'AMB' && ucs.sub === 'Room') return 'roomtone';
    if (ucs.cat === 'FART') return null;
    if (UCS[ucs.cat]) return UCS[ucs.cat];
  }
  // The file name says the most, then the description, then the folder names, closest folder
  // first (a "Doors" folder inside a "Voiceover" folder holds doors).
  const folders = rel.split('/').slice(0, -1).reverse();
  for (const text of [file.replace(/\.[^.]+$/, ''), desc || '', ...folders]) {
    const id = matchRules(text);
    if (id) return id;
  }
  return null;
}

function matchRules(text) {
  if (!text) return null;
  // Split camelCase ("WoodDoorCreak") and separators into words.
  const t = text.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/[_\-.\/,()\[\]]+/g, ' ');
  for (const [id, re] of RULES) {
    if (id === 'footsteps' && RE_RUN.test(t) && !RE_NOT_BODY.test(t)) return id;
    if (!re.test(t)) continue;
    if ((id === 'voice' || id === 'human') && RE_NOT_VOICE.test(t)) continue;
    return id;
  }
  return null;
}

// ------------------------------------------------------------------ audio
const N = 1024;
let fftTables = null;
function tables() {
  if (fftTables) return fftTables;
  const rev = new Uint32Array(N), cos = new Float64Array(N / 2), sin = new Float64Array(N / 2), win = new Float64Array(N);
  const bits = Math.log2(N);
  for (let i = 0; i < N; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  for (let i = 0; i < N / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / N); sin[i] = -Math.sin((2 * Math.PI * i) / N); }
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  return (fftTables = { rev, cos, sin, win });
}

function powerSpectrum(x, off, out, re, im) {
  const { rev, cos, sin, win } = tables();
  for (let i = 0; i < N; i++) { re[rev[i]] = x[off + i] * win[i]; im[rev[i]] = 0; }
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1, step = N / size;
    for (let i = 0; i < N; i += size) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const a = i + j, b = a + half;
        const tr = re[b] * cos[k] - im[b] * sin[k];
        const ti = re[b] * sin[k] + im[b] * cos[k];
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
  for (let i = 0; i < N / 2; i++) out[i] = re[i] * re[i] + im[i] * im[i];
}

function percentile(arr, p) {
  if (!arr.length) return -120;
  const s = Float64Array.from(arr).sort();
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

// segments: array of mono Float32Arrays (each a contiguous stretch of audio)
// at sample rate sr. dur: full file length in seconds.
export function analyzeFeatures(segments, sr, dur) {
  const d = Math.max(1, Math.round(sr / 22050));
  const rate = sr / d;
  const lo = Math.max(1, Math.round((100 / rate) * N)), hi = Math.min(N / 2 - 1, Math.round((8000 / rate) * N));
  const db = [], flats = [], rhythms = [], mods = [], depths = [];
  let onsets = 0, seconds = 0, active = 0, voiced = 0, lowSum = 0;
  const k1k = Math.round((1000 / rate) * N);
  const frameRate = rate / N;
  const p = new Float64Array(N / 2), re = new Float64Array(N), im = new Float64Array(N);
  for (const seg of segments) {
    // Decimate with a box filter (good enough for features).
    const n = Math.floor(seg.length / d);
    const y = new Float32Array(n);
    for (let i = 0, k = 0; i < n; i++) { let s = 0; for (let j = 0; j < d; j++) s += seg[k++]; y[i] = s / d; }
    seconds += n / rate;
    if (n < N) {
      let s = 0; for (let i = 0; i < n; i++) s += y[i] * y[i];
      if (n) db.push(10 * Math.log10(s / n + 1e-12));
      continue;
    }
    const flux = [], env = [];
    let prev = null;
    for (let off = 0; off + N <= n; off += N) {
      let s = 0; for (let i = 0; i < N; i++) s += y[off + i] * y[off + i];
      const fdb = 10 * Math.log10(s / N + 1e-12);
      db.push(fdb);
      env.push(fdb);
      powerSpectrum(y, off, p, re, im);
      if (fdb > -60) {
        let lg = 0, ar = 0;
        for (let i = lo; i <= hi; i++) { lg += Math.log(p[i] + 1e-12); ar += p[i]; }
        const cnt = hi - lo + 1;
        const fl = Math.exp(lg / cnt) / (ar / cnt + 1e-12);
        flats.push(fl);
        active++;
        if (fl < 0.1) {
          // pitched / harmonic frame: how much of it sits below 1 kHz?
          voiced++;
          let low = 0;
          for (let i = lo; i < k1k; i++) low += p[i];
          lowSum += low / (ar + 1e-12);
        }
      }
      const cur = new Float64Array(N / 2);
      let fl = 0;
      for (let i = 1; i < N / 2; i++) { cur[i] = Math.log1p(Math.sqrt(p[i]) * 10); if (prev) fl += Math.max(0, cur[i] - prev[i]); }
      flux.push(prev ? fl : 0);
      prev = cur;
    }
    // Onsets: flux peaks well above the local typical level.
    const med = percentile(flux, 0.5), mad = percentile(flux.map(v => Math.abs(v - med)), 0.5);
    const thr = med + 4 * mad + 1e-6;
    for (let i = 1; i + 1 < flux.length; i++) if (flux[i] > thr && flux[i] >= flux[i - 1] && flux[i] > flux[i + 1]) onsets++;
    // Rhythm: autocorrelation of the flux at 0.3 - 1.2 s (50 - 200 BPM).
    if (flux.length >= 48) {
      const m = flux.reduce((a, b) => a + b, 0) / flux.length;
      const z = flux.map(v => v - m);
      const r0 = z.reduce((a, b) => a + b * b, 0) + 1e-12;
      const hop = N / rate;
      let best = 0;
      for (let lag = Math.round(0.3 / hop); lag <= Math.round(1.2 / hop) && lag < z.length - 8; lag++) {
        let r = 0; for (let i = 0; i + lag < z.length; i++) r += z[i] * z[i + lag];
        best = Math.max(best, r / r0 * (z.length / (z.length - lag)));
      }
      rhythms.push(best);
    }
    // Syllable rate: how much of the loudness envelope's movement sits at
    // 2.5 - 7 Hz (speech) vs 0.5 - 10 Hz overall.
    if (env.length >= 32) {
      const top = percentile(env, 0.95);
      const e = env.map(v => Math.max(v, top - 45));
      const m = e.reduce((a, b) => a + b, 0) / e.length;
      const z = e.map(v => v - m);
      depths.push(Math.sqrt(z.reduce((a, b) => a + b * b, 0) / z.length));
      let band = 0, all = 0;
      for (let f = 0.5; f <= Math.min(10, frameRate / 2); f += 0.25) {
        let cr = 0, ci = 0;
        const w = (2 * Math.PI * f) / frameRate;
        for (let i = 0; i < z.length; i++) { cr += z[i] * Math.cos(w * i); ci -= z[i] * Math.sin(w * i); }
        const pw = cr * cr + ci * ci;
        all += pw;
        if (f >= 2.5 && f <= 7) band += pw;
      }
      if (all > 0) mods.push(band / all);
    }
  }
  const p95 = percentile(db, 0.95);
  return {
    dur,
    med: percentile(db, 0.5),
    p10: percentile(db, 0.1),
    p95,
    silent: db.length ? db.filter(v => v < Math.max(-65, p95 - 45)).length / db.length : 1,
    flat: flats.length ? percentile(flats, 0.5) : 0,
    onsets: seconds ? onsets / seconds : 0,
    rhythm: rhythms.length ? percentile(rhythms, 0.5) : 0,
    voiced: active ? voiced / active : 0,
    low: voiced ? lowSum / voiced : 0,
    mod: mods.length ? percentile(mods, 0.5) : 0,
    depth: depths.length ? percentile(depths, 0.5) : 0,
  };
}

export function classifyFeatures(f) {
  const dyn = f.p95 - f.p10;
  // Speech: mostly pitched with energy low in the spectrum (voices, not
  // birdsong), big syllable-to-syllable loudness swings with short gaps,
  // syllable-rate pulses, and no steady musical beat.
  if (f.dur >= 1.5 && f.voiced > 0.35 && f.voiced < 0.97 && f.low > 0.4 && f.depth > 8 &&
      f.silent > 0.03 && f.silent < 0.6 && f.onsets >= 0.8 && f.onsets <= 8 && f.mod > 0.2 && f.rhythm < 0.45) return 'voice';
  // Longer dialogue recordings over a noise floor: big syllable-to-syllable swings, no beat.
  if (f.dur >= 10 && f.depth >= 9 && f.low > 0.6 && f.onsets >= 0.8 && f.onsets <= 6 && f.rhythm < 0.45 && f.silent < 0.45) return 'voice';
  // Music: a steady beat, an even level (no speech-like swings) and no gaps. Most recordings
  // are pitched, so being tonal alone says nothing.
  if (f.dur >= 8 && f.silent < 0.1 && f.depth < 7 && dyn > 4 && f.onsets >= 1 && f.rhythm > 0.5) return 'musical';
  // Footsteps: evenly spaced, noisy transients with quieter gaps in between.
  if (f.dur >= 2.5 && f.onsets >= 0.8 && f.onsets <= 6 && f.rhythm > 0.3 && f.flat > 0.15 && dyn > 10) return 'footsteps';
  if (f.dur >= 3 && f.silent < 0.05 && dyn < 8 && f.p95 < -28 && f.flat > 0.12 && f.onsets < 0.4) return 'roomtone';
  if (f.dur >= 5 && f.silent < 0.25 && dyn < 24) return 'background';
  // A one-shot: by ear alone we can't tell a door from a metal hit, so leave it unsorted.
  return null;
}

// ------------------------------------------------------------------ music: tempo and key
// Keys are short names: "C", "F#m", "Bb"… (flats for Eb / Ab / Bb, sharps for the rest).
const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
export const KEYS = [...NOTE_NAMES, ...NOTE_NAMES.map(k => k + 'm')];
const LETTER = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const keyOf = (letter, acc, minor) => NOTE_NAMES[(LETTER[letter] + (/[#♯]/.test(acc || '') ? 1 : /[b♭]/.test(acc || '') ? 11 : 0)) % 12] + (minor ? 'm' : '');
// "F#m" -> 0..23 (minor keys from 12), -1 when it isn't a key.
export const keyIndex = k => KEYS.indexOf(k);

const RE_BPM = [/(?:^|[^\d.])(\d{2,3}(?:\.\d+)?) ?-?bpm(?![a-z])/i, /(?:^|[^a-z])bpm ?[-:=]? ?(\d{2,3})(?!\d)/i];
const RE_KEY_LONG = /(?:^|[^A-Za-z0-9])([A-G])(#|♯|b|♭)? ?-?([Mm]aj(?:or)?|[Mm]in(?:or)?)(?![a-z])/;
// A bare "C" or "Am" only counts right next to a tempo ("150bpm C", "Am 120 BPM").
// Case matters for the note letter (an "e" tag isn't E major).
const RE_KEY_AFTER_BPM = /[Bb][Pp][Mm][ -]*([A-G])(#|♯|b|♭)?(m(?:in)?|maj)?(?![A-Za-z0-9#])/;
const RE_KEY_BEFORE_BPM = /(?:^|[^A-Za-z0-9])([A-G])(#|♯|b|♭)?(m)?[ -]+\d{2,3} ?[Bb][Pp][Mm]/;

function nameMusic(text) {
  const t = text.replace(/_+/g, ' ');
  let bpm = 0, key = '';
  for (const re of RE_BPM) {
    const m = re.exec(t);
    if (m) { const v = Number(m[1]); if (v >= 40 && v <= 250) { bpm = Math.round(v * 10) / 10; break; } }
  }
  let k = RE_KEY_LONG.exec(t);
  if (k) key = keyOf(k[1], k[2], /^min/i.test(k[3]));
  else if (bpm && (k = RE_KEY_AFTER_BPM.exec(t) || RE_KEY_BEFORE_BPM.exec(t)) && /^[A-G]$/.test(k[1])) key = keyOf(k[1], k[2], /^m(in)?$/i.test(k[3] || ''));
  return { bpm, key };
}

// Tempo and key written in a file's name, its description, or its folders (closest first).
export function musicFromName(rel, desc) {
  const parts = rel.split('/');
  const texts = [parts.pop().replace(/\.[^.]+$/, ''), desc || '', ...parts.reverse()];
  let bpm = 0, key = '';
  for (const t of texts) {
    if (!t) continue;
    const m = nameMusic(t);
    if (!bpm) bpm = m.bpm;
    if (!key) key = m.key;
    if (bpm && key) break;
  }
  return { bpm, key };
}

const fftT = new Map();
function musicTables(n) {
  if (fftT.has(n)) return fftT.get(n);
  const bits = Math.log2(n), rev = new Uint32Array(n), cos = new Float64Array(n / 2), sin = new Float64Array(n / 2), win = new Float64Array(n);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = -Math.sin((2 * Math.PI * i) / n); }
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  const t = { rev, cos, sin, win };
  fftT.set(n, t);
  return t;
}
// Magnitudes of the windowed frame of x starting at off, into out (n/2 values).
function magnitudes(x, off, n, out, re, im) {
  const { rev, cos, sin, win } = musicTables(n);
  for (let i = 0; i < n; i++) { re[rev[i]] = x[off + i] * win[i]; im[rev[i]] = 0; }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const a = i + j, b = a + half;
        const tr = re[b] * cos[k] - im[b] * sin[k];
        const ti = re[b] * sin[k] + im[b] * cos[k];
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
  for (let i = 0; i < n / 2; i++) out[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
}

// Beats per minute from the autocorrelation of the onset strength, leaning towards 120.
function estimateTempo(y, rate) {
  const n = 512, hop = 128, h = hop / rate;
  const mag = new Float64Array(n / 2), re = new Float64Array(n), im = new Float64Array(n);
  let prev = null;
  const env = [];
  for (let off = 0; off + n <= y.length; off += hop) {
    magnitudes(y, off, n, mag, re, im);
    const cur = new Float64Array(n / 2);
    let fl = 0;
    for (let i = 1; i < n / 2; i++) { cur[i] = Math.log1p(mag[i] * 10); if (prev) fl += Math.max(0, cur[i] - prev[i]); }
    env.push(prev ? fl : 0);
    prev = cur;
  }
  if (env.length < 200) return 0;
  // Keep only what rises above the local average (about half a second).
  const W = Math.round(0.25 / h), o = new Float64Array(env.length);
  let s = 0;
  for (let i = 0; i < env.length + W; i++) {
    if (i < env.length) s += env[i];
    if (i - 2 * W - 1 >= 0) s -= env[i - 2 * W - 1];
    const c = i - W;
    if (c >= 0) o[c] = Math.max(0, env[c] - s / (Math.min(i, env.length - 1) - Math.max(0, i - 2 * W) + 1));
  }
  const lo = Math.floor(60 / 220 / h), hi = Math.ceil(60 / 50 / h);
  const acf = new Float64Array(Math.max(hi + 2, Math.min(o.length >> 1, 4 * hi + 2)));
  for (let l = 0; l < acf.length; l++) { let r = 0; for (let i = 0; i + l < o.length; i++) r += o[i] * o[i + l]; acf[l] = r / (o.length - l); }
  if (!(acf[0] > 0)) return 0;
  // A beat period also lines up with its multiples (2, 3, 4 beats later), which settles
  // between a tempo and 2/3 or 3/2 of it.
  const at = x => { const i = Math.floor(x), f = x - i; return i + 1 < acf.length ? acf[i] * (1 - f) + acf[i + 1] * f : 0; };
  const hiAll = acf.length - 1;
  let best = -1, bestS = 0;
  for (let l = lo; l <= hi; l++) {
    if (!(acf[l] >= acf[l - 1] && acf[l] >= acf[l + 1])) continue;
    let comb = acf[l], wsum = 1;
    for (let k = 2; k <= 4 && k * l <= hiAll; k++) { comb += at(k * l) / k; wsum += 1 / k; }
    const wgt = Math.exp(-0.5 * (Math.log2(60 / (l * h) / 120) / 0.9) ** 2); // leaning towards 120 BPM
    const sc = wgt * comb / wsum;
    if (sc > bestS) { bestS = sc; best = l; }
  }
  if (best < 0 || acf[best] / acf[0] < 0.08) return 0;
  const a = acf[best - 1], b = acf[best], c = acf[best + 1];
  const shift = a - 2 * b + c ? (0.5 * (a - c)) / (a - 2 * b + c) : 0;
  return Math.round(60 / ((best + shift) * h));
}

// Key from the average pitch-class profile, matched against the Krumhansl-Kessler profiles.
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
function corr(a, b) {
  const ma = a.reduce((x, y) => x + y, 0) / 12, mb = b.reduce((x, y) => x + y, 0) / 12;
  let s = 0, sa = 0, sb = 0;
  for (let i = 0; i < 12; i++) { s += (a[i] - ma) * (b[i] - mb); sa += (a[i] - ma) ** 2; sb += (b[i] - mb) ** 2; }
  return sa && sb ? s / Math.sqrt(sa * sb) : 0;
}
// Runs on the full-rate audio: a cheap decimation would fold distorted highs into false notes.
function estimateKey(y, rate) {
  let n = 4096;
  while (n < rate * 0.3) n *= 2;
  const mag = new Float64Array(n / 2), re = new Float64Array(n), im = new Float64Array(n);
  const chroma = new Float64Array(12);
  let frames = 0;
  for (let off = 0; off + n <= y.length; off += n / 2) {
    magnitudes(y, off, n, mag, re, im);
    const c = new Float64Array(12);
    let tot = 0;
    // Spectral peaks only, placed at their exact pitch; ones far between two notes count less.
    for (let k = 2; k < n / 2 - 1; k++) {
      const m = mag[k];
      if (!(m > mag[k - 1] && m >= mag[k + 1])) continue;
      const a = mag[k - 1], b = mag[k + 1];
      const p = k + (a - b ? (0.5 * (a - b)) / (a - 2 * m + b) : 0);
      const f = (p * rate) / n;
      if (f < 80 || f > 2000) continue;
      const semis = 12 * Math.log2(f / 261.6256), near = Math.round(semis);
      const wdev = Math.cos(Math.PI * (semis - near)) ** 2;
      const v = Math.sqrt(m) * wdev;
      c[((near % 12) + 12) % 12] += v;
      tot += v;
    }
    if (tot < 1e-3) continue;
    for (let i = 0; i < 12; i++) chroma[i] += c[i] / tot;
    frames++;
  }
  if (frames < 8) return '';
  let best = '', bestR = -1;
  for (let r = 0; r < 12; r++) {
    const rot = Array.from({ length: 12 }, (_, i) => chroma[(i + r) % 12]);
    for (const [prof, minor] of [[MAJOR, false], [MINOR, true]]) {
      const v = corr(rot, prof);
      if (v > bestR) { bestR = v; best = NOTE_NAMES[r] + (minor ? 'm' : ''); }
    }
  }
  return bestR >= KEY_MIN_R ? best : '';
}
const KEY_MIN_R = 0.7; // below this the music is too chromatic (or too sparse) to name a key

// Tempo and key by ear, from a stretch of mono audio (20 - 30 s works best). 0 / '' when unsure.
export function musicFeatures(x, sr) {
  const d = Math.max(1, Math.round(sr / 11025)), rate = sr / d;
  const n = Math.floor(x.length / d);
  if (n < rate * 6) return { bpm: 0, key: '' };
  const y = new Float32Array(n);
  for (let i = 0, k = 0; i < n; i++) { let s = 0; for (let j = 0; j < d; j++) s += x[k++]; y[i] = s / d; }
  return { bpm: estimateTempo(y, rate), key: estimateKey(x, sr) };
}
