import { dec, ra, star, type ConstellationData } from "./catalog";

/**
 * The initial constellations. Positions are J2000 right ascension/declination and magnitudes are apparent
 * visual magnitudes, transcribed from standard bright-star catalogues (to within a few arcseconds, far
 * finer than a particle body can show). Variable stars (Betelgeuse, γ Cas) use a typical magnitude. Lines
 * follow the familiar stick figures; they are drawing conventions, not astronomy. Stars that would merge
 * with a brighter neighbour at this scale (e.g. φ¹ and φ² Ori beside Meissa) are left out, so a clump
 * never reads as one bright star.
 */

export const ORION: ConstellationData = {
  id: "orion",
  name: "Orion",
  stars: [
    star("betelgeuse", "Betelgeuse (α Ori)", "05 55 10.31", "+07 24 25.4", 0.5),
    star("rigel", "Rigel (β Ori)", "05 14 32.27", "-08 12 05.9", 0.13),
    star("bellatrix", "Bellatrix (γ Ori)", "05 25 07.86", "+06 20 58.9", 1.64),
    star("mintaka", "Mintaka (δ Ori)", "05 32 00.40", "-00 17 56.7", 2.23),
    star("alnilam", "Alnilam (ε Ori)", "05 36 12.81", "-01 12 06.9", 1.69),
    star("alnitak", "Alnitak (ζ Ori)", "05 40 45.53", "-01 56 33.3", 1.77),
    star("saiph", "Saiph (κ Ori)", "05 47 45.39", "-09 40 10.6", 2.09),
    star("meissa", "Meissa (λ Ori)", "05 35 08.28", "+09 56 03.0", 3.39),
    star("iota", "Hatysa (ι Ori)", "05 35 25.98", "-05 54 35.6", 2.77),
    star("theta1", "Trapezium (θ¹ Ori)", "05 35 16.46", "-05 23 22.8", 4.0),
    star("c", "42 Ori", "05 35 23.16", "-04 50 18.1", 4.59),
    star("pi1", "π¹ Ori", "04 54 53.73", "+10 09 02.9", 4.65),
    star("pi2", "π² Ori", "04 50 36.72", "+08 54 00.7", 4.35),
    star("pi3", "Tabit (π³ Ori)", "04 49 50.41", "+06 57 40.6", 3.19),
    star("pi4", "π⁴ Ori", "04 51 12.37", "+05 36 18.4", 3.69),
    star("pi5", "π⁵ Ori", "04 54 15.10", "+02 26 26.4", 3.72),
    star("pi6", "π⁶ Ori", "04 58 32.91", "+01 42 50.5", 4.47),
    star("mu", "μ Ori", "06 02 22.99", "+09 38 50.2", 4.12),
    star("nu", "ν Ori", "06 07 34.33", "+14 46 06.5", 4.42),
    star("xi", "ξ Ori", "06 11 56.40", "+14 12 31.6", 4.45),
    star("chi1", "χ¹ Ori", "05 54 22.98", "+20 16 34.2", 4.39),
    star("chi2", "χ² Ori", "06 03 55.18", "+20 08 18.4", 4.63),
  ],
  lines: [
    ["meissa", "betelgeuse"], ["meissa", "bellatrix"],
    ["betelgeuse", "alnitak"], ["bellatrix", "mintaka"],
    ["mintaka", "alnilam"], ["alnilam", "alnitak"],
    ["alnitak", "saiph"], ["mintaka", "rigel"],
    ["c", "theta1"], ["theta1", "iota"],
    ["betelgeuse", "mu"], ["mu", "nu"], ["nu", "xi"], ["nu", "chi2"], ["chi2", "chi1"],
    ["bellatrix", "pi3"], ["pi1", "pi2"], ["pi2", "pi3"], ["pi3", "pi4"], ["pi4", "pi5"], ["pi5", "pi6"],
  ],
  // The Orion Nebula (M42) around the Trapezium, in the sword.
  haze: [{ ra: ra("05 35 17"), dec: dec("-05 23 28"), radius: 0.45, strength: 0.6 }],
};

export const URSA_MAJOR: ConstellationData = {
  id: "ursa-major",
  name: "Ursa Major",
  stars: [
    star("dubhe", "Dubhe (α UMa)", "11 03 43.67", "+61 45 03.7", 1.79),
    star("merak", "Merak (β UMa)", "11 01 50.48", "+56 22 56.7", 2.37),
    star("phecda", "Phecda (γ UMa)", "11 53 49.85", "+53 41 41.1", 2.44),
    star("megrez", "Megrez (δ UMa)", "12 15 25.56", "+57 01 57.4", 3.31),
    star("alioth", "Alioth (ε UMa)", "12 54 01.75", "+55 57 35.4", 1.77),
    star("mizar", "Mizar (ζ UMa)", "13 23 55.54", "+54 55 31.3", 2.23),
    star("alcor", "Alcor (80 UMa)", "13 25 13.54", "+54 59 16.7", 3.99),
    star("alkaid", "Alkaid (η UMa)", "13 47 32.44", "+49 18 47.8", 1.86),
    star("muscida", "Muscida (ο UMa)", "08 30 15.87", "+60 43 05.4", 3.36),
    star("h", "23 UMa", "09 31 31.71", "+63 03 42.7", 3.65),
    star("upsilon", "υ UMa", "09 50 59.36", "+59 02 19.4", 3.8),
    star("theta", "θ UMa", "09 32 51.43", "+51 40 38.3", 3.17),
    star("iota", "Talitha (ι UMa)", "08 59 12.45", "+48 02 30.6", 3.14),
    star("kappa", "Alkaphrah (κ UMa)", "09 03 37.53", "+47 09 23.5", 3.6),
    star("lambda", "Tania Borealis (λ UMa)", "10 17 05.79", "+42 54 51.7", 3.45),
    star("mu", "Tania Australis (μ UMa)", "10 22 19.74", "+41 29 58.3", 3.06),
    star("psi", "ψ UMa", "11 09 39.81", "+44 29 54.6", 3.01),
    star("chi", "χ UMa", "11 46 03.01", "+47 46 45.9", 3.69),
    star("nu", "Alula Borealis (ν UMa)", "11 18 28.74", "+33 05 39.5", 3.49),
    star("xi", "Alula Australis (ξ UMa)", "11 18 10.90", "+31 31 44.9", 3.79),
  ],
  lines: [
    // The Big Dipper.
    ["alkaid", "mizar"], ["mizar", "alioth"], ["alioth", "megrez"], ["megrez", "dubhe"], ["dubhe", "merak"], ["merak", "phecda"], ["phecda", "megrez"],
    // Head and front legs.
    ["dubhe", "h"], ["h", "muscida"], ["h", "upsilon"], ["upsilon", "theta"], ["theta", "iota"], ["theta", "kappa"],
    // Hind legs.
    ["phecda", "chi"], ["chi", "nu"], ["nu", "xi"], ["chi", "psi"], ["psi", "mu"], ["mu", "lambda"],
  ],
};

export const CASSIOPEIA: ConstellationData = {
  id: "cassiopeia",
  name: "Cassiopeia",
  stars: [
    star("caph", "Caph (β Cas)", "00 09 10.69", "+59 08 59.2", 2.27),
    star("schedar", "Schedar (α Cas)", "00 40 30.44", "+56 32 14.4", 2.24),
    star("gamma", "γ Cas", "00 56 42.53", "+60 43 00.3", 2.47),
    star("ruchbah", "Ruchbah (δ Cas)", "01 25 48.95", "+60 14 07.0", 2.68),
    star("segin", "Segin (ε Cas)", "01 54 23.73", "+63 40 12.4", 3.37),
    star("eta", "Achird (η Cas)", "00 49 06.29", "+57 48 54.7", 3.44),
    star("zeta", "ζ Cas", "00 36 58.28", "+53 53 48.9", 3.66),
    star("kappa", "κ Cas", "00 32 59.99", "+62 55 54.4", 4.16),
  ],
  lines: [["caph", "schedar"], ["schedar", "gamma"], ["gamma", "ruchbah"], ["ruchbah", "segin"]],
};

export const SCORPIUS: ConstellationData = {
  id: "scorpius",
  name: "Scorpius",
  stars: [
    star("antares", "Antares (α Sco)", "16 29 24.46", "-26 25 55.2", 1.06),
    star("acrab", "Acrab (β¹ Sco)", "16 05 26.23", "-19 48 19.6", 2.62),
    star("dschubba", "Dschubba (δ Sco)", "16 00 20.01", "-22 37 18.2", 2.29),
    star("pi", "Fang (π Sco)", "15 58 51.11", "-26 06 50.8", 2.89),
    star("rho", "ρ Sco", "15 56 53.08", "-29 12 50.7", 3.87),
    star("nu", "Jabbah (ν Sco)", "16 11 59.74", "-19 27 38.6", 4.0),
    star("sigma", "Alniyat (σ Sco)", "16 21 11.32", "-25 35 34.1", 2.88),
    star("tau", "Paikauhale (τ Sco)", "16 35 52.95", "-28 12 57.7", 2.82),
    star("epsilon", "Larawag (ε Sco)", "16 50 09.81", "-34 17 35.6", 2.29),
    star("mu1", "Xamidimura (μ¹ Sco)", "16 51 52.23", "-38 02 50.6", 3.0),
    star("zeta2", "ζ² Sco", "16 54 35.00", "-42 21 40.7", 3.62),
    star("eta", "η Sco", "17 12 09.20", "-43 14 21.1", 3.33),
    star("theta", "Sargas (θ Sco)", "17 37 19.13", "-42 59 52.2", 1.86),
    star("iota1", "ι¹ Sco", "17 47 35.08", "-40 07 37.2", 2.99),
    star("kappa", "Girtab (κ Sco)", "17 42 29.28", "-39 01 47.9", 2.39),
    star("lambda", "Shaula (λ Sco)", "17 33 36.52", "-37 06 13.8", 1.62),
    star("upsilon", "Lesath (υ Sco)", "17 30 45.84", "-37 17 44.9", 2.7),
  ],
  lines: [
    ["nu", "acrab"], ["acrab", "dschubba"], ["dschubba", "pi"], ["pi", "rho"],
    ["dschubba", "sigma"], ["sigma", "antares"], ["antares", "tau"], ["tau", "epsilon"], ["epsilon", "mu1"], ["mu1", "zeta2"],
    ["zeta2", "eta"], ["eta", "theta"], ["theta", "iota1"], ["iota1", "kappa"], ["kappa", "lambda"], ["lambda", "upsilon"],
  ],
};

export const LEO: ConstellationData = {
  id: "leo",
  name: "Leo",
  stars: [
    star("regulus", "Regulus (α Leo)", "10 08 22.31", "+11 58 01.9", 1.35),
    star("eta", "η Leo", "10 07 19.95", "+16 45 45.6", 3.48),
    star("algieba", "Algieba (γ Leo)", "10 19 58.35", "+19 50 29.4", 2.0),
    star("adhafera", "Adhafera (ζ Leo)", "10 16 41.42", "+23 25 02.3", 3.44),
    star("rasalas", "Rasalas (μ Leo)", "09 52 45.82", "+26 00 25.0", 3.88),
    star("algenubi", "Algenubi (ε Leo)", "09 45 51.07", "+23 46 27.3", 2.98),
    star("zosma", "Zosma (δ Leo)", "11 14 06.50", "+20 31 25.4", 2.56),
    star("chertan", "Chertan (θ Leo)", "11 14 14.40", "+15 25 46.5", 3.33),
    star("denebola", "Denebola (β Leo)", "11 49 03.58", "+14 34 19.4", 2.13),
    star("iota", "ι Leo", "11 23 55.45", "+10 31 44.9", 3.94),
    star("sigma", "σ Leo", "11 21 08.19", "+06 01 45.6", 4.05),
    star("rho", "ρ Leo", "10 32 48.67", "+09 18 23.7", 3.85),
  ],
  lines: [
    // The Sickle: the lion's head and mane.
    ["algenubi", "rasalas"], ["rasalas", "adhafera"], ["adhafera", "algieba"], ["algieba", "eta"], ["eta", "regulus"],
    // Body and hindquarters.
    ["algieba", "zosma"], ["zosma", "denebola"], ["denebola", "chertan"], ["chertan", "zosma"], ["chertan", "regulus"],
    ["chertan", "iota"], ["iota", "sigma"], ["regulus", "rho"],
  ],
};

export const CYGNUS: ConstellationData = {
  id: "cygnus",
  name: "Cygnus",
  stars: [
    star("deneb", "Deneb (α Cyg)", "20 41 25.92", "+45 16 49.2", 1.25),
    star("sadr", "Sadr (γ Cyg)", "20 22 13.70", "+40 15 24.0", 2.23),
    star("albireo", "Albireo (β Cyg)", "19 30 43.28", "+27 57 34.8", 3.05),
    star("aljanah", "Aljanah (ε Cyg)", "20 46 12.68", "+33 58 12.9", 2.48),
    star("fawaris", "Fawaris (δ Cyg)", "19 44 58.48", "+45 07 50.9", 2.87),
    star("eta", "η Cyg", "19 56 18.37", "+35 05 00.3", 3.89),
    star("zeta", "ζ Cyg", "21 12 56.19", "+30 13 36.9", 3.21),
    star("iota", "ι Cyg", "19 29 42.36", "+51 43 47.2", 3.79),
    star("kappa", "κ Cyg", "19 17 06.17", "+53 22 06.5", 3.8),
  ],
  lines: [
    // The Northern Cross: the swan's neck and body, then its wings.
    ["deneb", "sadr"], ["sadr", "eta"], ["eta", "albireo"],
    ["fawaris", "sadr"], ["sadr", "aljanah"], ["aljanah", "zeta"], ["fawaris", "iota"], ["iota", "kappa"],
  ],
};

export const PLEIADES: ConstellationData = {
  id: "pleiades",
  name: "Pleiades",
  stars: [
    star("alcyone", "Alcyone (η Tau)", "03 47 29.08", "+24 06 18.5", 2.87),
    star("atlas", "Atlas (27 Tau)", "03 49 09.74", "+24 03 12.3", 3.62),
    star("electra", "Electra (17 Tau)", "03 44 52.54", "+24 06 48.0", 3.7),
    star("maia", "Maia (20 Tau)", "03 45 49.61", "+24 22 03.9", 3.87),
    star("merope", "Merope (23 Tau)", "03 46 19.57", "+23 56 54.1", 4.18),
    star("taygeta", "Taygeta (19 Tau)", "03 45 12.50", "+24 28 02.2", 4.3),
    star("pleione", "Pleione (28 Tau)", "03 49 11.22", "+24 08 12.2", 5.05),
    star("celaeno", "Celaeno (16 Tau)", "03 44 48.22", "+24 17 22.1", 5.45),
    star("asterope", "Asterope (21 Tau)", "03 45 54.48", "+24 33 16.2", 5.76),
  ],
  // An open cluster, not a figure: no lines, and the faint blue reflection nebula around its stars.
  lines: [],
  haze: [{ ra: ra("03 46 30"), dec: dec("+24 10 00"), radius: 0.42, strength: 0.55 }],
};

export const CONSTELLATIONS = [ORION, URSA_MAJOR, CASSIOPEIA, SCORPIUS, LEO, CYGNUS, PLEIADES] as const;
