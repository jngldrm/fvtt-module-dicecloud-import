// Set up the user interface
Hooks.on("renderSidebarTab", async (app, html) => {
    if (app.options.id == "compendium") {
        let button = $("<button class='import-dicecloud'><i class='fas fa-file-import'></i> DiceCloud Import</button>")

        button.click(function () {
            new DiceCloudImporter().render(true);
        });

        html.find(".directory-footer").append(button);
    }
})

const Noop = () => undefined;

// Main module class
class DiceCloudImporter extends Application {
    static moduleId = "dicecloud-import";
    static defaultSpellCompendia = [
        "Dynamic-Effects-SRD.DAE SRD Midi-collection",
        "Dynamic-Effects-SRD.DAE SRD Spells",
        "dnd5e.spells",
        () => `world.ddb-${game.world.name}-spells`,
    ];
    static defaultFeatureCompendia = [
        "Dynamic-Effects-SRD.DAE SRD Feats",
        "dnd5e.classfeatures",
        "dnd5e.races",
    ];
    static defaultSpeciesCompendia = [
        "dnd5e.races",
        "Dynamic-Effects-SRD.DAE SRD Races",
        () => `world.ddb-${game.world.name}-races`,
    ];
    static defaultBackgroundCompendia = [
        "dnd5e.backgrounds",
        "Dynamic-Effects-SRD.DAE SRD Backgrounds",
        () => `world.ddb-${game.world.name}-backgrounds`,
    ];

    static normalizeCharacter(rawCharacter) {
        if (rawCharacter?.character && rawCharacter?.collections) {
            return rawCharacter;
        }

        if (rawCharacter?.meta?.type === "DiceCloud V2 Creature Archive") {
            return this.normalizeV2Archive(rawCharacter);
        }

        throw new Error("Unsupported DiceCloud export format");
    }

    static normalizeV2Archive(archive) {
        const charId = archive?.creature?._id ?? (
            typeof randomID === "function"
                ? randomID()
                : (typeof foundry !== "undefined" && foundry?.utils?.randomID)
                    ? foundry.utils.randomID()
                    : Math.random().toString(36).slice(2, 18)
        );
        const properties = Array.isArray(archive?.properties) ? archive.properties : [];

        const allowedEffectOps = new Set(["base", "add", "mul", "advantage", "disadvantage"]);
        const effects = [];

        for (const prop of properties) {
            if (!prop?.variableName || !Array.isArray(prop.effects)) continue;

            for (const effect of prop.effects) {
                if (!allowedEffectOps.has(effect?.operation)) continue;
                const amount = effect?.amount ?? {};
                effects.push({
                    _id: effect?._id ?? `${prop._id}-${effect.operation}`,
                    charId,
                    stat: prop.variableName,
                    operation: effect.operation,
                    value: amount?.value ?? null,
                    calculation: amount?.calculation ?? null,
                    enabled: effect?.disabled === true ? false : true,
                });
            }
        }

        const hitPointsProp = properties.find((prop) => prop?.variableName === "hitPoints");
        const hitPointsTotal = hitPointsProp?.total ?? 0;
        const hitPointsValue = hitPointsProp?.value ?? hitPointsTotal;
        const hitPointAdjustment = hitPointsValue - hitPointsTotal;

        const tempHPProp = properties.find((prop) => prop?.variableName === "tempHP");
        const temporaryHitPoints = tempHPProp
            ? [{
                _id: tempHPProp._id,
                charId,
                maximum: tempHPProp.total ?? 0,
                used: Math.max(0, (tempHPProp.total ?? 0) - (tempHPProp.value ?? 0)),
            }]
            : [];

        const skillProps = properties.filter((prop) => prop?.type === "skill");
        const characterSkills = {};
        for (const skill of skillProps) {
            if (!skill?.variableName) continue;
            characterSkills[skill.variableName] = {
                ability: skill?.ability ?? null,
            };
        }

        const proficiencyProps = properties.filter((prop) => prop?.type === "proficiency");
        const proficiencies = [];
        for (const prop of proficiencyProps) {
            const stats = Array.isArray(prop?.stats) ? prop.stats : [];
            const value = prop?.value ?? 0;
            for (const stat of stats) {
                const type = DiceCloudImporter.inferProficiencyType(stat);
                proficiencies.push({
                    _id: `${prop._id}-${stat}`,
                    charId,
                    type,
                    enabled: value > 0,
                    name: stat,
                    value,
                });
            }
        }

        const classLevelProps = properties.filter((prop) => prop?.type === "classLevel");
        const classTotals = new Map();
        for (const cls of classLevelProps) {
            const name = cls?.name ?? "";
            if (!name) continue;
            const level = cls?.level ?? 0;
            classTotals.set(name, (classTotals.get(name) ?? 0) + level);
        }
        const classes = Array.from(classTotals.entries()).map(([name, level], idx) => ({
            _id: `class-${idx}`,
            charId,
            name,
            level,
        }));

        const spellListProps = properties.filter((prop) => prop?.type === "spellList");
        const spellLists = spellListProps.map((list, idx) => ({
            _id: list?._id ?? `spell-list-${idx}`,
            charId,
            name: list?.name ?? "",
            ability: list?.ability ?? null,
            attackBonus: `${list?.ability ?? ""}Mod`,
        }));

        const containerProps = properties.filter((prop) => prop?.type === "container");
        const containers = containerProps.map((container) => ({
            _id: container?._id,
            charId,
            name: container?.name ?? "",
        }));

        const itemProps = properties.filter((prop) => prop?.type === "item");
        const items = itemProps.map((item) => ({
            _id: item?._id,
            charId,
            name: item?.name ?? "",
            quantity: item?.quantity ?? 0,
            enabled: item?.equipped ?? false,
            description: item?.description?.value ?? "",
            weight: item?.weight ?? 0,
            value: item?.value ?? 0,
            parent: item?.parent ?? null,
        }));

        const spellProps = properties.filter((prop) => prop?.type === "spell");
        const spells = spellProps.map((spell) => ({
            _id: spell?._id,
            charId,
            name: spell?.name ?? "",
            level: spell?.level ?? 0,
            description: spell?.summary?.value ?? spell?.description?.value ?? "",
            range: typeof spell?.range === "string" ? spell.range : "",
            duration: typeof spell?.duration === "string" ? spell.duration : "",
            components: {
                verbal: !!spell?.verbal,
                somatic: !!spell?.somatic,
                concentration: !!spell?.concentration,
                ritual: !!spell?.ritual,
                material: spell?.material ?? "",
            },
            prepared: spell?.alwaysPrepared ? "always" : (spell?.prepared ? "prepared" : "unprepared"),
        }));

        const raceFolder = DiceCloudImporter.findTaggedProperty(properties, "race");
        const backgroundFolder = DiceCloudImporter.findTaggedProperty(properties, "background");

        const featureProps = properties.filter((prop) => (
            prop?.type === "feature"
            && prop?.inactive !== true
            && prop?.deactivatedByAncestor !== true
        ));
        const features = featureProps.map((feature) => ({
            _id: feature?._id,
            charId,
            name: feature?.name ?? "",
            description: feature?.description?.value ?? feature?.summary?.value ?? "",
        }));

        const species = raceFolder ? [{
            _id: raceFolder._id,
            charId,
            name: raceFolder.name ?? "",
            description: raceFolder?.description?.value ?? raceFolder?.description?.text ?? "",
        }] : [];

        const backgrounds = backgroundFolder ? [{
            _id: backgroundFolder._id,
            charId,
            name: backgroundFolder.name ?? "",
            description: backgroundFolder?.description?.value ?? backgroundFolder?.description?.text ?? "",
        }] : [];

        const character = {
            _id: charId,
            name: archive?.creature?.name ?? "DiceCloud Import",
            picture: archive?.creature?.picture ?? archive?.creature?.img ?? null,
            alignment: "",
            appearance: "",
            backstory: "",
            description: "",
            bonds: "",
            flaws: "",
            ideals: "",
            race: raceFolder?.name ?? "",
            personality: "",
            background: backgroundFolder?.name ?? "",
            hitPoints: {
                adjustment: hitPointAdjustment,
            },
            ...characterSkills,
        };

        return {
            character,
            collections: {
                effects,
                proficiencies,
                spellLists,
                temporaryHitPoints,
                items,
                containers,
                spells,
                classes,
                features,
                species,
                backgrounds,
            },
            rawV2: archive,
        };
    }

    static inferProficiencyType(stat) {
        if (!stat) {
            return "skill";
        }

        const lower = stat.toLowerCase();
        if (lower.endsWith("save")) {
            return "save";
        }
        if (lower.includes("armor")) {
            return "armor";
        }
        if (lower.includes("weapon")) {
            return "weapon";
        }
        if (lower.includes("tool")) {
            return "tool";
        }
        if (lower.includes("language")) {
            return "language";
        }
        return "skill";
    }

    static abilityValueFallback(parsedCharacter, stat) {
        if (parsedCharacter?.rawV2?.properties) {
            const abilityProp = parsedCharacter.rawV2.properties.find((prop) => prop?.variableName === stat);
            if (abilityProp) {
                return abilityProp.total ?? abilityProp.value ?? 10;
            }
        }

        return 10;
    }

    static abilityTranslations = new Map([
        ["strength", "str"],
        ["dexterity", "dex"],
        ["constitution", "con"],
        ["intelligence", "int"],
        ["wisdom", "wis"],
        ["charisma", "cha"],
    ]);

    static parseSpellDuration(durationText) {
        if (typeof durationText !== "string") {
            return {};
        }

        const clean = durationText.trim();
        if (!clean) {
            return {};
        }

        const lower = clean.toLowerCase();

        if (clean.includes("{")) {
            return { units: "spec", special: clean };
        }

        if (lower.includes("instant")) {
            return { units: "inst" };
        }

        if (lower.includes("until dispelled") || lower.includes("permanent")) {
            return { units: "perm" };
        }

        const durationUnits = new Map([
            ["round", "round"],
            ["rounds", "round"],
            ["turn", "turn"],
            ["turns", "turn"],
            ["minute", "minute"],
            ["minutes", "minute"],
            ["hour", "hour"],
            ["hours", "hour"],
            ["day", "day"],
            ["days", "day"],
            ["month", "month"],
            ["months", "month"],
            ["year", "year"],
            ["years", "year"],
        ]);

        const digitsMatch = clean.match(/([0-9]+(?:\.[0-9]+)?)/);
        if (!digitsMatch) {
            return { units: "spec", special: clean };
        }

        const value = Number(digitsMatch[1]);
        if (!Number.isFinite(value)) {
            return { units: "spec", special: clean };
        }

        const unitText = lower.slice(digitsMatch.index + digitsMatch[0].length).trim();
        const unitMatch = unitText.match(/^(rounds?|turns?|minutes?|hours?|days?|months?|years?)/);

        if (!unitMatch) {
            return { units: "spec", special: clean };
        }

        const units = durationUnits.get(unitMatch[1]);
        if (!units) {
            return { units: "spec", special: clean };
        }

        return { value, units };
    }

    static parseSpellRange(rangeText) {
        if (typeof rangeText !== "string") {
            return {};
        }

        const clean = rangeText.trim();
        if (!clean) {
            return {};
        }

        const lower = clean.toLowerCase();

        if (clean.includes("{")) {
            return { units: "spec", special: clean };
        }

        if (lower === "self") {
            return { units: "self" };
        }

        if (lower.startsWith("self")) {
            return { units: "self", special: clean };
        }

        if (lower === "touch") {
            return { units: "touch" };
        }

        if (lower.startsWith("touch")) {
            return { units: "touch", special: clean };
        }

        if (lower === "none") {
            return { units: "none" };
        }

        if (lower.includes("sight")) {
            return { units: "spec", special: clean };
        }

        const digitsMatch = clean.match(/([0-9]+(?:\.[0-9]+)?)/);
        if (!digitsMatch) {
            return { units: "spec", special: clean };
        }

        const value = Number(digitsMatch[1]);
        if (!Number.isFinite(value)) {
            return { units: "spec", special: clean };
        }

        let units = "ft";
        if (lower.includes("mile")) {
            units = "mi";
        }

        return { value, units };
    }

    static featureNameCandidates(name) {
        if (typeof name !== "string") {
            return [];
        }

        const trimmed = name.trim();
        if (!trimmed) {
            return [];
        }

        const candidates = new Set([trimmed]);

        const noBracket = trimmed.replace(/\s*\[[^\]]+\]\s*$/, "").trim();
        if (noBracket) {
            candidates.add(noBracket);
        }

        const noParens = trimmed.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s{2,}/g, " ").trim();
        if (noParens && noParens !== trimmed) {
            candidates.add(noParens);
        }

        const colonParts = trimmed.split(":").map((part) => part.trim()).filter(Boolean);
        if (colonParts.length > 1) {
            colonParts.forEach((part) => candidates.add(part));
            const afterFirst = colonParts.slice(1).join(": ").trim();
            if (afterFirst) {
                candidates.add(afterFirst);
            }
        }

        return Array.from(candidates);
    }

    static findTaggedProperty(properties, tag) {
        if (!Array.isArray(properties)) {
            return null;
        }

        const matches = properties.filter((prop) => {
            if (!prop || prop?.inactive === true || prop?.deactivatedByAncestor === true) {
                return false;
            }
            const tags = new Set();
            if (Array.isArray(prop?.tags)) {
                prop.tags.forEach((value) => tags.add(value));
            }
            if (Array.isArray(prop?.libraryTags)) {
                prop.libraryTags.forEach((value) => tags.add(value));
            }
            return tags.has(tag);
        });

        if (matches.length === 0) {
            return null;
        }

        const folderMatch = matches.find((prop) => prop?.type === "folder");
        if (folderMatch) {
            return folderMatch;
        }

        return matches[0];
    }

    static resolveDefaultCompendia(defaults) {
        return defaults
            .map((entry) => typeof entry === "function" ? entry() : entry)
            .filter((id) => typeof id === "string" && id.length > 0);
    }

    static registerSettings() {
        if (!game?.settings) {
            return;
        }

        const defaults = {
            spellsCompendia: JSON.stringify(this.resolveDefaultCompendia(this.defaultSpellCompendia)),
            featuresCompendia: JSON.stringify(this.resolveDefaultCompendia(this.defaultFeatureCompendia)),
            speciesCompendia: JSON.stringify(this.resolveDefaultCompendia(this.defaultSpeciesCompendia)),
            backgroundsCompendia: JSON.stringify(this.resolveDefaultCompendia(this.defaultBackgroundCompendia)),
        };

        for (const [key, defaultValue] of Object.entries(defaults)) {
            if (!game.settings.settings.has(`${this.moduleId}.${key}`)) {
                game.settings.register(this.moduleId, key, {
                    scope: "world",
                    config: false,
                    type: String,
                    default: defaultValue,
                });
            }
        }
    }

    static getCompendiumSetting(key, defaults) {
        if (!game?.settings) {
            return Array.isArray(defaults) ? [...defaults] : [];
        }
        const stored = game.settings.get(this.moduleId, key);
        if (!stored) {
            return Array.isArray(defaults) ? [...defaults] : [];
        }
        try {
            const parsed = JSON.parse(stored);
            if (Array.isArray(parsed)) {
                return parsed.filter((id) => typeof id === "string" && id.length > 0);
            }
        } catch (err) {
            console.warn(`Failed to parse DiceCloud setting ${key}`, err);
        }
        return Array.isArray(defaults) ? [...defaults] : [];
    }

    static setCompendiumSetting(key, values) {
        if (!game?.settings) {
            return;
        }
        const unique = Array.from(new Set((Array.isArray(values) ? values : []).filter((id) => typeof id === "string" && id.length > 0)));
        game.settings.set(this.moduleId, key, JSON.stringify(unique));
    }

    static openSettings() {
        new DiceCloudImporterSettings().render(true);
    }

    static get defaultOptions() {
        const options = super.defaultOptions;
        options.id = "dicecloudimporter";
        options.template = "modules/dicecloud-import/templates/dicecloud_import_ui.html"
        options.classes.push("dicecloud-importer");
        options.resizable = false;
        options.height = "auto";
        options.width = 400;
        options.minimizable = true;
        options.title = "DiceCloud Importer"
        return options;
    }

    activateListeners(html) {
        super.activateListeners(html)
        html.find(".import-dicecloud").click(async ev => {
            let dicecloudJSON = html.find('[name=dicecloud-json]').val();
            let updateBool = html.find('[name=updateButton]').is(':checked');
            await DiceCloudImporter.parseCharacter(dicecloudJSON, updateBool)
        });
        html.find(".dicecloud-settings").click(ev => {
            ev.preventDefault();
            DiceCloudImporter.openSettings();
        });
        this.close();
    }

    static abilityLevel(parsedCharacter, effectsByStat, ability) {
        let abilityLevel = 10;
        DiceCloudImporter.applyEffectOperations(parsedCharacter, effectsByStat, ability, (base) => {
            abilityLevel = base;
        }, (changeFunc) => {
            abilityLevel = changeFunc(abilityLevel);
        }, Noop);
        return abilityLevel;
    }

    static abilityModifier(parsedCharacter, effectsByStat, ability) {
        return Math.trunc((this.abilityLevel(parsedCharacter, effectsByStat, ability) - 10) / 2);
    }

    static arbitaryCalculation(parsedCharacter, effectsByStat, calculation) {
        if (calculation === "level * constitutionMod") {
            const constitutionMod = this.abilityModifier(parsedCharacter, effectsByStat, "constitution");
            return DiceCloudImporter.getLevel(parsedCharacter) * constitutionMod;
        } else if (calculation === "dexterityArmor") {
            return 10 + this.abilityModifier(parsedCharacter, effectsByStat, "dexterity");
        } else {
            console.warn(`Could not calculate ${calculation}`)
            return 0;
        }
    }

    static applyEffectOperations(parsedCharacter, effectsByStat, stat, baseValue, changeValue, changeAdvantage) {
        function effectValue(effect) {
            if (effect.value != null) {
                return effect.value;
            } else if (effect.calculation != null) {
                return DiceCloudImporter.arbitaryCalculation(parsedCharacter, effectsByStat, effect.calculation);
            } else {
                throw new Error(`could not determine effect value for ${JSON.stringify(effect)}`);
            }
        }

        if (!effectsByStat.has(stat)) {
            console.warn(`No effects found for stat ${stat}`);
            return;
        }

        const effectList = (effectsByStat.get(stat) || []).filter((effect) => effect.enabled);
        const baseEffects = effectList.filter((effect) => effect.operation === "base");
        if (baseEffects.length === 0) {
            console.warn(`No base value for effects ${effectList}`);
        } else {
            baseValue(effectValue(baseEffects[baseEffects.length - 1]));
        }

        effectList.forEach((effect) => {
            let value = effectValue(effect);
            switch (effect.operation) {
                case "base":
                    break;
                case "add":
                    changeValue((previousValue) => previousValue + value)
                    break;
                case "mul":
                    changeValue((previousValue) => previousValue * value)
                    break;
                case "advantage":
                    changeAdvantage(+1);
                    break;
                case "disadvantage":
                    changeAdvantage(-1);
                    break;
                default:
                    throw new Error(`effect operation "${effect.operation}" not implemented`)
            }
        });
    }

    static parseAbilities(parsedCharacter, effectsByStat) {
        const charId = parsedCharacter.character._id;
        const abilities = {};
        const proficiencyCollection = Array.isArray(parsedCharacter.collections?.proficiencies)
            ? parsedCharacter.collections.proficiencies
            : [];
        const proficientAbilities = new Map(proficiencyCollection
            .filter((prof) => prof.enabled && prof.charId === charId && prof.type === "save")
            .map((prof) => [prof.name.replace(/Save$/, ""), prof.value]));
        Array.from(this.abilityTranslations.keys()).forEach((stat) => {
            const shortStat = this.abilityTranslations.get(stat);
            let abilityValue = this.abilityLevel(parsedCharacter, effectsByStat, stat);
            if (!Number.isFinite(abilityValue)) {
                abilityValue = DiceCloudImporter.abilityValueFallback(parsedCharacter, stat);
            }
            abilities[shortStat] = {
                proficient: proficientAbilities.has(stat) ? proficientAbilities.get(stat) : 0,
                value: abilityValue,
            };
        });
        return abilities;
    }

    static parseAttributes(parsedCharacter, effectsByStat) {
        const charId = parsedCharacter.character._id;

        const spellcastingTranslations = new Map(
            ["intelligence", "wisdom", "charisma"]
                .map((ability) => [ability + "Mod", this.abilityTranslations.get(ability)])
        );
        const spellLists = Array.isArray(parsedCharacter.collections.spellLists)
            ? parsedCharacter.collections.spellLists.filter((spellList) => spellList.charId === charId)
            : [];
        let spellcasting = Array.from(spellcastingTranslations.keys()).filter((value) =>
            spellLists.some((spellList) => typeof spellList.attackBonus === "string" && spellList.attackBonus.includes(value))
        );
        if (spellcasting.length === 0) {
            spellcasting = ["charismaMod"];
        }
        spellcasting = spellcastingTranslations.get(spellcasting[0]);

        let speed = 30;
        this.applyEffectOperations(parsedCharacter, effectsByStat, "speed", (base) => {
            speed = base;
        }, (changeFunc) => {
            speed = changeFunc(speed);
        }, Noop);

        if (parsedCharacter?.rawV2?.properties) {
            const speedProp = parsedCharacter.rawV2.properties.find((prop) => prop?.variableName === "speed");
            if (speedProp?.total != null) {
                speed = speedProp.total;
            }
        }

        let armor = 10;
        this.applyEffectOperations(parsedCharacter, effectsByStat, "armor", (base) => {
            armor = base;
        }, (changeFunc) => {
            armor = changeFunc(armor);
        }, Noop)

        if (armor === 10 && parsedCharacter?.rawV2?.properties) {
            const armorProp = parsedCharacter.rawV2.properties.find((prop) => prop?.variableName === "armor");
            if (armorProp?.total != null) {
                armor = armorProp.total;
            }
        }

        const hp = {
            value: 20,
            min: 0,
            max: 20,
        }

        this.applyEffectOperations(parsedCharacter, effectsByStat, "hitPoints", (base) => {
            hp.max = base;
        }, (changeFunc) => {
            hp.max = changeFunc(hp.max);
        }, Noop);
        hp.value = hp.max + parsedCharacter.character.hitPoints.adjustment
        const tempHPCollection = Array.isArray(parsedCharacter.collections?.temporaryHitPoints)
            ? parsedCharacter.collections.temporaryHitPoints
            : [];
        const tempHP = tempHPCollection.filter((tempHP) => tempHP.charId === charId);
        if (tempHP.length !== 0) {
            hp["temp"] = tempHP[0].maximum - tempHP[0].used
            hp["tempmax"] = tempHP[0].maximum
        }

        if (hp.max === 20 && parsedCharacter?.rawV2?.properties) {
            const hpProp = parsedCharacter.rawV2.properties.find((prop) => prop?.variableName === "hitPoints");
            if (hpProp) {
                hp.max = hpProp.total ?? hp.max;
                hp.value = hpProp.value ?? hp.max;
            }
        }

        return {
            ac: {
                value: armor,
            },
            death: {
                success: 0,
                failure: 0,
            },
            inspiration: 0,
            exhaustion: 0,
            encumbrance: {
                value: null,
                max: null
            },
            hp,
            init: {
                value: 0,
                bonus: 0,
            },
            movement: {
                burrow: 0,
                climb: 0,
                fly: 0,
                hover: false,
                swim: 0,
                units: "ft",
                walk: speed,
            },
            senses: {
                blindsight: 0,
                darkvision: 0,
                special: "",
                tremorsense: 0,
                truesight: 0,
                units: "ft"
            },
            spellcasting,
            spelldc: 10,
        };
    }

    static parseDetails(parsedCharacter) {
        return {
            alignment: this.stripMarkdownLinks(parsedCharacter.character.alignment),
            appearance: "",
            background: this.stripMarkdownLinks(parsedCharacter.character.background ?? ""),
            biography: {
                value: this.markdownToHTML(parsedCharacter.character.description),
            },
            bond: this.markdownToHTML(parsedCharacter.character.bonds),
            flaw: this.markdownToHTML(parsedCharacter.character.flaws),
            ideal: this.markdownToHTML(parsedCharacter.character.ideals),
            level: this.getLevel(parsedCharacter),
            race: this.stripMarkdownLinks(parsedCharacter.character.race),
            trait: this.markdownToHTML(parsedCharacter.character.personality),
            source: `DiceCloud`,
        };
    }

    static stripMarkdownLinks(text) {
        return text.replaceAll(/\[(.+?)\]\(https?:\/\/.+?\)/g, "$1").replace(/^🔗\s*/, "");
    }

    static markdownToHTML(text) {
        if (!text) {
            return "";
        }

        return text
            .replaceAll(/\n\s*\n/g, "<br><br>")
            .replaceAll(/\[(.+?)\]\((https?:\/\/.+?)\)/g, "<a href=\"$2\">$1</a>");
    }

    static getLevel(parsedCharacter) {
        return parsedCharacter.collections.classes.reduce((v, c) => v + c.level, 0);
    }

    static parseCurrency(parsedCharacter) {
        const itemCollection = Array.isArray(parsedCharacter.collections?.items)
            ? parsedCharacter.collections.items
            : [];

        let copper_pieces = itemCollection.find(i => i.name === "Copper piece");
        let silver_pieces = itemCollection.find(i => i.name === "Silver piece");
        let electrum_pieces = itemCollection.find(i => i.name === "Electrum piece");
        let gold_pieces = itemCollection.find(i => i.name === "Gold piece");
        let platinum_pieces = itemCollection.find(i => i.name === "Platinum piece");

        return {
            cp: copper_pieces ? copper_pieces.quantity : 0,
            ep: electrum_pieces ? electrum_pieces.quantity : 0,
            gp: gold_pieces ? gold_pieces.quantity : 0,
            pp: platinum_pieces ? platinum_pieces.quantity : 0,
            sp: silver_pieces ? silver_pieces.quantity : 0,
        };
    }

    static async prepareCompendiums(compendiums) {
        let prepared_compendiums = compendiums.map(comp => game.packs.get(comp));
        prepared_compendiums = prepared_compendiums.filter(comp => !!comp);

        await Promise.all(
            prepared_compendiums.map(compendium => compendium.getIndex())
        );

        return prepared_compendiums;
    }

    static async findInCompendiums(compendiums, name) {
        const lowerName = name?.trim().toLowerCase();
        if (!lowerName) {
            return null;
        }

        const gameEntity = game.items?.find?.((i) => i.name?.toLowerCase() === lowerName);

        if (gameEntity) {
            return gameEntity;
        }

        for (let compendium of compendiums) {
            let item = compendium.index.find((value) => value.name?.toLowerCase() === lowerName);

            if (item) {
                return await compendium.getDocument(item._id);
            }
        }

        return null;
    }

    static async parseItems(actor, parsedCharacter) {
        let currencyItems = ["Copper piece", "Silver piece", "Electrum piece", "Gold piece", "Platinum piece"];

        const srd_item_name_map = new Map([
            ["Clothes, common", "Common Clothes"],
            ["Clothes, costume", "Costume Clothes"],
            ["Clothes, fine", "Fine Clothes"],
            ["Clothes, traveler’s", "Traveler's Clothes"],
            ["Wooden Shield", "Shield"],
            ["Rations (1 day)", "Rations"],
            ["Wooden staff (druidic focus)", "Wooden Staff"],
            ["Paper (one sheet)", "Paper"],
            ["Ink (1 ounce bottle)", "Ink Bottle"],
            ["Rope, hempen (50 feet)", "Hempen Rope (50 ft.)"],
            ["Oil (flask)", "Oil Flask"],
            ["Case, map or scroll", "Map or Scroll Case"],
            ["Perfume (vial)", "Perfume"],
        ]);

        const ignore_containers = ["Robe of Useful Items"];

        const containerCollection = Array.isArray(parsedCharacter.collections?.containers)
            ? parsedCharacter.collections.containers
            : [];

        const ignore_container_ids = containerCollection.filter(
            v => ignore_containers.includes(v.name)).map(v => v._id);

        const compendiums = await this.prepareCompendiums([
            "Dynamic-Effects-SRD.DAE SRD Items",
            "dnd5e.items",
            `world.ddb-${game.world.name}-items`
        ]);

        const itemCollection = Array.isArray(parsedCharacter.collections?.items)
            ? parsedCharacter.collections.items
            : [];

        let filteredItems = itemCollection.filter(v => !currencyItems.includes(v.name))

        let items = [];
        for (let item of filteredItems) {
            const parentId = item?.parent?.id;
            if (parentId && ignore_container_ids.includes(parentId)) {
                continue;
            }

            let itemName = item.name;
            if (srd_item_name_map.has(itemName)) {
                itemName = srd_item_name_map.get(itemName);
            }

            let existing_entity = await this.findInCompendiums(compendiums, itemName);

            if (existing_entity) {
                const entityData = existing_entity.toObject();
                delete entityData._id;
                const createdItems = await actor.createEmbeddedDocuments("Item", [entityData]);
                const created = createdItems[0];
                if (created) {
                    await actor.updateEmbeddedDocuments("Item", [{
                        _id: created.id,
                        system: {
                            quantity: item.quantity,
                            equipped: item.enabled,
                        },
                    }]);
                }
            } else {
                let item_entity = {
                    name: item.name,
                    type: "loot",
                    system: {
                        quantity: item.quantity,
                        description: {
                            value: this.markdownToHTML(item.description)
                        },
                        equipped: item.enabled,
                        weight: item.weight,
                        price: {
                            value: item.value,
                        },
                        value: item.value,
                    }
                };
                items.push(item_entity);
            }
        }
        if (items.length !== 0) {
            await actor.createEmbeddedDocuments("Item", items);
        }
    }

    static async parseSpells(actor, parsedCharacter) {
        const defaultSpells = this.resolveDefaultCompendia(this.defaultSpellCompendia);
        const spellPackIds = this.getCompendiumSetting("spellsCompendia", defaultSpells);
        const compendiums = await this.prepareCompendiums(spellPackIds);

        const spellSchoolTranslation = new Map([
            ["Abjuration", "abj"],
            ["Illusion", "ill"],
            ["Transmutation", "trs"],
            ["Enchantment", "enc"],
            ["Divination", "div"],
            ["Evocation", "evo"],
        ]);

        const spells = Array.isArray(parsedCharacter.collections?.spells)
            ? parsedCharacter.collections.spells
            : [];

        for (let spell of spells) {
            let existing_spell = await this.findInCompendiums(compendiums, spell.name);

            let entity = null;
            if (existing_spell) {
                const spellData = existing_spell.toObject();
                delete spellData._id;
                const createdSpells = await actor.createEmbeddedDocuments("Item", [spellData]);
                entity = createdSpells[0];
            } else {
                const range = DiceCloudImporter.parseSpellRange(spell.range);
                const duration = DiceCloudImporter.parseSpellDuration(spell.duration);

                let school = spellSchoolTranslation.has(spell.school) ?
                    spellSchoolTranslation.get(spell.school) : spell.school;

                const createdSpells = await actor.createEmbeddedDocuments("Item", [{
                    name: spell.name,
                    type: "spell",
                    system: {
                        level: spell.level,
                        description: {
                            value: spell.description,
                        },
                        components: {
                            vocal: spell.components.verbal,
                            somatic: spell.components.somatic,
                            concentration: spell.components.concentration,
                            ritual: spell.components.ritual,
                            material: spell.components.material,
                        },
                        school: school,
                        duration: duration,
                        range: range,
                        preparation: {
                            mode: spell.level > 0 ? "prepared" : "always",
                            prepared: spell.prepared === "prepared" || spell.level === 0,
                        },
                        materials: {
                            value: spell.components.material,
                        },
                    },
                }]);
                entity = createdSpells[0];
            }

            if (entity) {
                await actor.updateEmbeddedDocuments("Item", [{
                    _id: entity.id,
                    system: {
                        preparation: {
                            mode: spell.level > 0 ? "prepared" : "always",
                            prepared: spell.prepared === "prepared" || spell.level === 0,
                        },
                    },
                }]);
            }
        }
    }

    static async parseLevels(actor, parsedCharacter) {
        const compendiums = await this.prepareCompendiums(["dnd5e.classes"]);

        const classes = Array.isArray(parsedCharacter.collections?.classes)
            ? parsedCharacter.collections.classes
            : [];

        for (let c_class of classes) {
            let srd_item = await this.findInCompendiums(compendiums, c_class.name);

            if (srd_item) {
                const itemData = srd_item.toObject();
                delete itemData._id;
                const createdClasses = await actor.createEmbeddedDocuments("Item", [itemData]);
                const created = createdClasses[0];
                if (created) {
                    await actor.updateEmbeddedDocuments("Item", [{
                        _id: created.id,
                        system: {
                            levels: c_class.level,
                        },
                    }]);
                }
            } else {
                let item_data = {
                    name: c_class.name,
                    type: "class",
                    system: {
                        levels: c_class.level,
                    },
                }
                await actor.createEmbeddedDocuments("Item", [item_data]);
            }
        }
    }

    static async parseFeatures(actor, parsedCharacter) {
        const defaultFeatures = this.resolveDefaultCompendia(this.defaultFeatureCompendia);
        const featurePackIds = this.getCompendiumSetting("featuresCompendia", defaultFeatures);
        const compendiums = await this.prepareCompendiums(featurePackIds);

        const ignore_class_features = [
            "Base Ability Scores",
            "Jack of All Trades",
            "Song of Rest",
            "Wild Shape",
        ]

        const features = Array.isArray(parsedCharacter.collections?.features)
            ? parsedCharacter.collections.features
            : [];

        for (let feature of features) {
            if (ignore_class_features.includes(feature.name)) {
                continue;
            }

            if (feature.name.toLowerCase() === "darkvision") {
                let range = feature.description.split(" ")[0];

                await actor.update({
                    "system.attributes.senses.darkvision": range,
                })
            }

            let srd_item = null;
            const nameCandidates = DiceCloudImporter.featureNameCandidates(feature.name);
            for (const candidate of nameCandidates) {
                srd_item = await this.findInCompendiums(compendiums, candidate);
                if (srd_item) {
                    break;
                }
            }

            if (srd_item) {
                const featureData = srd_item.toObject();
                delete featureData._id;
                await actor.createEmbeddedDocuments("Item", [featureData]);
            } else {
                await actor.createEmbeddedDocuments("Item", [{
                    type: "feat",
                    name: feature.name,
                    system: {
                        description: {
                            value: feature.description,
                        }
                    }
                }]);
            }
        }
    }

    static async parseSpecies(actor, parsedCharacter) {
        const speciesCollection = Array.isArray(parsedCharacter.collections?.species)
            ? parsedCharacter.collections.species
            : [];
        if (speciesCollection.length === 0) {
            return;
        }

        const defaultSpecies = this.resolveDefaultCompendia(this.defaultSpeciesCompendia);
        const speciesPackIds = this.getCompendiumSetting("speciesCompendia", defaultSpecies);
        const compendiums = await this.prepareCompendiums(speciesPackIds);

        for (const species of speciesCollection) {
            if (!species?.name) {
                continue;
            }

            let srd_item = null;
            const nameCandidates = DiceCloudImporter.featureNameCandidates(species.name);
            for (const candidate of nameCandidates) {
                srd_item = await this.findInCompendiums(compendiums, candidate);
                if (srd_item) {
                    break;
                }
            }

            if (srd_item) {
                const itemData = srd_item.toObject();
                delete itemData._id;
                await actor.createEmbeddedDocuments("Item", [itemData]);
            } else {
                await actor.createEmbeddedDocuments("Item", [{
                    type: "race",
                    name: species.name,
                    system: {
                        description: {
                            value: this.markdownToHTML(species.description || ""),
                        },
                    },
                }]);
            }
        }
    }

    static async parseBackgrounds(actor, parsedCharacter) {
        const backgroundCollection = Array.isArray(parsedCharacter.collections?.backgrounds)
            ? parsedCharacter.collections.backgrounds
            : [];
        if (backgroundCollection.length === 0) {
            return;
        }

        const defaultBackgrounds = this.resolveDefaultCompendia(this.defaultBackgroundCompendia);
        const backgroundPackIds = this.getCompendiumSetting("backgroundsCompendia", defaultBackgrounds);
        const compendiums = await this.prepareCompendiums(backgroundPackIds);

        for (const background of backgroundCollection) {
            if (!background?.name) {
                continue;
            }

            let srd_item = null;
            const nameCandidates = DiceCloudImporter.featureNameCandidates(background.name);
            for (const candidate of nameCandidates) {
                srd_item = await this.findInCompendiums(compendiums, candidate);
                if (srd_item) {
                    break;
                }
            }

            if (srd_item) {
                const itemData = srd_item.toObject();
                delete itemData._id;
                await actor.createEmbeddedDocuments("Item", [itemData]);
            } else {
                await actor.createEmbeddedDocuments("Item", [{
                    type: "background",
                    name: background.name,
                    system: {
                        description: {
                            value: this.markdownToHTML(background.description || ""),
                        },
                    },
                }]);
            }
        }
    }

    static parseProficiencies(parsedCharacter, type, known_proficiencies) {
        const proficiencyCollection = Array.isArray(parsedCharacter.collections?.proficiencies)
            ? parsedCharacter.collections.proficiencies
            : [];
        const proficiencies = proficiencyCollection.filter(
            prof => prof.type === type && prof.enabled
        )

        const values = proficiencies.flatMap(prof => prof.name.split(", "));

        const known_values = values.filter(prof => known_proficiencies.has(prof.toLowerCase()));
        const unknown_values = values.filter(prof => !known_proficiencies.has(prof.toLowerCase()));

        const result = {
            selected: {
                custom1: unknown_values.join(", "),
            },
            custom: unknown_values.join(", "),
            value: []
        }

        for (let value of known_values) {
            const known_proficiency = known_proficiencies.get(value.toLowerCase());

            result.value.push(known_proficiency.key);
            result.selected[known_proficiency.key] = known_proficiency.name;
        }

        return result;
    }

    static parseTraits(parsedCharacter) {
        const known_languages = new Map([
            ["aarakocra", {key: "aarakocra", name: "Aarakocra"}],
            ["aquan", {key: "aquan", name: "Aquan"}],
            ["auran", {key: "auran", name: "Auran"}],
            ["thieves' cant", {key: "cant", name: "Thieves' Cant"}],
            ["celestial", {key: "celestial", name: "Celestial"}],
            ["common", {key: "common", name: "Common"}],
            ["deep speech", {key: "deep", name: "Deep Speech"}],
            ["draconic", {key: "draconic", name: "Draconic"}],
            ["druidic", {key: "druidic", name: "Druidic"}],
            ["dwarvish", {key: "dwarvish", name: "Dwarvish"}],
            ["elvish", {key: "elvish", name: "Elvish"}],
            ["giant", {key: "giant", name: "Giant"}],
            ["gith", {key: "gith", name: "Gith"}],
            ["gnoll", {key: "gnoll", name: "Gnoll"}],
            ["gnomish", {key: "gnomish", name: "Gnomish"}],
            ["goblin", {key: "goblin", name: "Goblin"}],
            ["halfling", {key: "halfing", name: "Halfling"}],
            ["ignan", {key: "ignan", name: "Ignan"}],
            ["infernal", {key: "infernal", name: "Infernal"}],
            ["orc", {key: "orc", name: "Orc"}],
            ["primordial", {key: "primordial", name: "Primordial"}],
            ["sylvan", {key: "sylvan", name: "Sylvan"}],
            ["terran", {key: "terran", name: "Terran"}],
            ["undercommon", {key: "undercommon", name: "Undercommon"}],
        ]);

        const known_armor = new Map([
            ["heavy armor", {key: "hvy", name: "Heavy Armor"}],
            ["medium armor", {key: "med", name: "Medium Armor"}],
            ["light armor", {key: "lgt", name: "Light Armor"}],
            ["shields", {key: "shl", name: "Shields"}],
        ]);

        const known_weapons = new Map([
            ["simple weapons", {key: "sim", name: "Simple Weapons"}],
            ["martial weapons", {key: "mar", name: "Martial Weapons"}],
        ]);

        const known_tools = new Map([
            ["artisan's tools", {key: "art", name: "Artisan's Tools"}],
            ["disguise kit", {key: "disg", name: "Disguise Kit"}],
            ["forgery kit", {key: "forg", name: "Forgery Kit"}],
            ["gaming set", {key: "game", name: "Gaming Set"}],
            ["herbalism kit", {key: "herb", name: "Herbalism Kit"}],
            ["musical instrument", {key: "music", name: "Musical Instrument"}],
            ["navigator's tools", {key: "navg", name: "Navigator's Tools"}],
            ["poisoner's kit", {key: "pois", name: "Poisoner's Kit"}],
            ["thieves' tools", {key: "thief", name: "Thieves' Tools"}],
            ["vehicle", {key: "vehicle", name: "Vehicle (Land or Water)"}],
        ]);

        return {
            size: "med",
            di: {
                value: []
            },
            dr: {
                value: []
            },
            dv: {
                value: []
            },
            ci: {
                value: []
            },
            senses: "",
            languages: this.parseProficiencies(parsedCharacter, "language", known_languages),
            toolProf: this.parseProficiencies(parsedCharacter, "tool", known_tools),
            armorProf: this.parseProficiencies(parsedCharacter, "armor", known_armor),
            weaponProf: this.parseProficiencies(parsedCharacter, "weapon", known_weapons),
        };
    }

    static async parseEmbeddedEntities(actor, parsedCharacter) {
        try {
            await DiceCloudImporter.parseItems(actor, parsedCharacter);
            const dae = typeof globalThis !== "undefined" ? globalThis.DAE : (typeof DAE !== "undefined" ? DAE : null);
            if (dae?.migrateActorItems) {
                await dae.migrateActorItems(actor);
            }
            await DiceCloudImporter.parseLevels(actor, parsedCharacter);
            await DiceCloudImporter.parseSpells(actor, parsedCharacter);
            await DiceCloudImporter.parseSpecies(actor, parsedCharacter);
            await DiceCloudImporter.parseBackgrounds(actor, parsedCharacter);
            await DiceCloudImporter.parseFeatures(actor, parsedCharacter);
        } catch (e) {
            console.error(e);
        }
    }

    static async parseCharacter(characterJSON, updateBool) {
        // Parse CritterDB JSON data pasted in UI
        // Determine if this is a single monster or a bestiary by checking for creatures array
        let parsedCharacter = DiceCloudImporter.normalizeCharacter(JSON.parse(characterJSON));
        // console.log(updateBool)

        // Dictionary to map monster size strings
        let size_dict = {
            "Tiny": "tiny",
            "Small": "sm",
            "Medium": "med",
            "Large": "lrg",
            "Huge": "huge",
            "Gargantuan": "grg"
        };

        // Find image if present
        let img_url = "icons/svg/mystery-man.png";

        if (parsedCharacter.character.picture) {
            img_url = parsedCharacter.character.picture;
        }

        const charId = parsedCharacter.character._id
        const effectsByStat = new Map();
        const effectCollection = Array.isArray(parsedCharacter.collections?.effects)
            ? parsedCharacter.collections.effects
            : [];
        effectCollection
            .filter((effect) => effect.charId === charId)
            .forEach((effect) => {
                if (effectsByStat.has(effect.stat)) {
                    effectsByStat.get(effect.stat).push(effect);
                } else {
                    effectsByStat.set(effect.stat, [effect]);
                }
            });

        // Create the temporary actor data structure
        let tempActor = {
            name: parsedCharacter.character.name,
            type: "character",
            img: img_url,
            prototypeToken: {
                name: parsedCharacter.character.name,
                texture: {
                    src: img_url,
                },
            },
            system: {
                abilities: DiceCloudImporter.parseAbilities(parsedCharacter, effectsByStat),
                attributes: DiceCloudImporter.parseAttributes(parsedCharacter, effectsByStat),
                currency: DiceCloudImporter.parseCurrency(parsedCharacter),
                details: DiceCloudImporter.parseDetails(parsedCharacter),
                traits: DiceCloudImporter.parseTraits(parsedCharacter),
                skills: DiceCloudImporter.parseSkills(parsedCharacter),
            },
            items: [],
        };

        // Create owned "Items" for spells, actions, and abilities
        // WIP: Loop over the critterDB stats.additionalAbilities, actions, reactions, and legendaryActions
        // to generate Foundry "items" for attacks/spells/etc

        console.log(tempActor);

        // Check if this actor already exists and handle update/replacement
        let existingActor = game.actors.find(c => c.name === tempActor.name);

        if (existingActor == null) {
            let thisActor = await Actor.create(tempActor, { temporary: false, renderSheet: false });

            await this.parseEmbeddedEntities(thisActor, parsedCharacter);

            // Wrap up
            console.log(`Done importing ${tempActor.name}`);
            ui.notifications.info(`Done importing ${tempActor.name}`);
        } else if (updateBool) {
            const updateData = {
                _id: existingActor.id,
                name: tempActor.name,
                system: tempActor.system,
            };

            await existingActor.update(updateData);

            const deletions = existingActor.items.map(i => i.id);
            await existingActor.deleteEmbeddedDocuments("Item", deletions);

            await this.parseEmbeddedEntities(existingActor, parsedCharacter);

            console.log(`Updated ${tempActor.name}`);
            ui.notifications.info(`Updated data for ${tempActor.name}`);
        } else {
            console.log(`${tempActor.name} already exists. Skipping`);
            ui.notifications.error(`${tempActor.name} already exists. Skipping`);
        }
    }

    static parseSkills(parsedCharacter) {
        const charId = parsedCharacter.character._id;
        const skillTranslations = new Map([
            ["acrobatics", "acr"],
            ["animalHandling", "ani"],
            ["arcana", "arc"],
            ["athletics", "ath"],
            ["deception", "dec"],
            ["history", "his"],
            ["insight", "ins"],
            ["intimidation", "itm"],
            ["investigation", "inv"],
            ["medicine", "med"],
            ["nature", "nat"],
            ["perception", "prc"],
            ["performance", "prf"],
            ["persuasion", "per"],
            ["religion", "rel"],
            ["sleightOfHand", "slt"],
            ["stealth", "ste"],
            ["survival", "sur"],
        ]);
        const skills = {};
        const proficiencyCollection = Array.isArray(parsedCharacter.collections?.proficiencies)
            ? parsedCharacter.collections.proficiencies
            : [];
        const proficientSkills = new Map(proficiencyCollection
            .filter((prof) => prof.enabled && prof.charId === charId && prof.type === "skill")
            .map((prof) => [prof.name, prof.value]));
        Array.from(skillTranslations.keys()).forEach((skill) => {
            const skillObj = parsedCharacter.character[skill];
            if (skillObj == null) {
                console.warn(`skill "${skill}" not found on character`);
                return;
            }
            // not sure if the skill ability really has to be set, but it is defined on both ends
            const skillAbility = skillObj.ability;
            if (skillAbility == null) {
                console.warn(`skill ability for "${skill}" not found on character`);
                return;
            }

            skills[skillTranslations.get(skill)] = {
                value: proficientSkills.has(skill) ? proficientSkills.get(skill) : 0,
                ability: this.abilityTranslations.get(skillAbility),
            };
        });
        return skills;
    }
}

class DiceCloudImporterSettings extends FormApplication {
    static get defaultOptions() {
        const options = super.defaultOptions;
        options.id = "dicecloud-import-settings";
        options.template = "modules/dicecloud-import/templates/dicecloud_import_settings.html";
        options.title = "DiceCloud Import Settings";
        options.width = 500;
        options.height = "auto";
        options.resizable = true;
        options.classes = options.classes ?? [];
        options.classes.push("dicecloud-import-settings");
        return options;
    }

    getData() {
        const spellSelection = new Set(DiceCloudImporter.getCompendiumSetting(
            "spellsCompendia",
            DiceCloudImporter.resolveDefaultCompendia(DiceCloudImporter.defaultSpellCompendia)
        ));
        const featureSelection = new Set(DiceCloudImporter.getCompendiumSetting(
            "featuresCompendia",
            DiceCloudImporter.resolveDefaultCompendia(DiceCloudImporter.defaultFeatureCompendia)
        ));
        const speciesSelection = new Set(DiceCloudImporter.getCompendiumSetting(
            "speciesCompendia",
            DiceCloudImporter.resolveDefaultCompendia(DiceCloudImporter.defaultSpeciesCompendia)
        ));
        const backgroundSelection = new Set(DiceCloudImporter.getCompendiumSetting(
            "backgroundsCompendia",
            DiceCloudImporter.resolveDefaultCompendia(DiceCloudImporter.defaultBackgroundCompendia)
        ));

        const packs = Array.from(game.packs.values())
            .filter((pack) => pack.metadata?.type === "Item")
            .map((pack) => ({
                collection: pack.collection,
                title: pack.title ?? pack.metadata?.label ?? pack.collection,
                metadata: pack.metadata,
                spellSelected: spellSelection.has(pack.collection),
                featureSelected: featureSelection.has(pack.collection),
                speciesSelected: speciesSelection.has(pack.collection),
                backgroundSelected: backgroundSelection.has(pack.collection),
            }))
            .sort((a, b) => a.title.localeCompare(b.title));

        return {
            packs,
        };
    }

    async _updateObject(event, formData) {
        const normalize = (value) => {
            if (!value) {
                return [];
            }
            if (Array.isArray(value)) {
                return value.filter(Boolean);
            }
            return [value];
        };

        const spellPacks = normalize(formData.spellsCompendia);
        const featurePacks = normalize(formData.featuresCompendia);
        const speciesPacks = normalize(formData.speciesCompendia);
        const backgroundPacks = normalize(formData.backgroundsCompendia);

        DiceCloudImporter.setCompendiumSetting("spellsCompendia", spellPacks);
        DiceCloudImporter.setCompendiumSetting("featuresCompendia", featurePacks);
        DiceCloudImporter.setCompendiumSetting("speciesCompendia", speciesPacks);
        DiceCloudImporter.setCompendiumSetting("backgroundsCompendia", backgroundPacks);

        ui.notifications?.info?.("DiceCloud Import settings saved");
    }
}

Hooks.once("init", () => {
    DiceCloudImporter.registerSettings();
});
