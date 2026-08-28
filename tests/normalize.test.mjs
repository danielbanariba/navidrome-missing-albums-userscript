// How titles are compared, which is where the panel got things wrong.
//
// The script has no build step and no module system — it is one file a browser
// executes — so the functions under test are lifted out of the source by name.
// That is uglier than importing them and it keeps the shipped file a userscript,
// which is the whole point of it.
//
// Every case here happened. Two catalogues never spell a record the same way,
// and each disagreement had the same shape: two names for one album read as two
// albums, so a record already in the library was drawn as missing.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(
  join(HERE, "..", "navidrome-missing-albums.user.js"),
  "utf8"
);

function lift(pattern, label) {
  const found = SOURCE.match(pattern);
  if (!found) throw new Error(`${label} not found in the userscript`);
  return found[1];
}

const ABBREV = eval("(" + lift(/const ABBREV = (\{[\s\S]*?\});/, "ABBREV") + ")");
const normalize = eval(
  "(" + lift(/(function normalize\(name\) \{[\s\S]*?\n {2}\})/, "normalize") + ")"
);
const splitParts = eval(
  "(" + lift(/(function splitParts\(key\) \{[\s\S]*?\n {2}\})/, "splitParts") + ")"
);

// The prefix rule: an owned copy carries what the pressing added to the title.
function owns(have, catalogue) {
  const mine = normalize(have);
  const theirs = normalize(catalogue);
  if (mine === theirs || mine.startsWith(theirs + " ")) return true;
  const parts = splitParts(mine);
  return parts !== null && parts === splitParts(theirs);
}

const SAME = [
  ["Mr Patate", "M. Patate"],
  ["St. Anger", "Saint Anger"],
  ["Vol. 2", "Volume 2"],
  ["Rock & Roll", "Rock and Roll"],
  ["Xibalbá", "Xibalba"],
  ["OBJECTIF : THUNES", "Objectif: Thunes"],
  ["Live in Paris (01-09-05)", "Live in Paris"],
  ["Abismo (Remastered)", "Abismo"],
  // A bracketed group inside a word is part of the title. Stripping it turned
  // "Pussy(De)Luxe" into "pussy luxe" and listed one album twice.
  ["Pussy(De)Luxe", "Pussy De Luxe"],
  // A split names two acts and no two catalogues order them the same way.
  ["Mizar vs Spasm", "Spasm / Mizar"],
];

const DIFFERENT = [
  ["Demo", "Demos"],
  ["Spasm / Mizar", "Spasm / Gutalax"],
  ["Abismo", "Abismo II"],
  // The prefix rule runs one way only: holding the 1999 demo, which
  // MusicBrainz files as "Ultra Vomit", must not satisfy the 2024 album.
  ["Ultra Vomit", "Ultra Vomit et le pouvoir de la puissance"],
];

test("the same record spelled two ways", () => {
  for (const [left, right] of SAME) {
    assert.ok(owns(left, right), `${left} and ${right} are one record`);
  }
});

test("records that only look alike", () => {
  for (const [left, right] of DIFFERENT) {
    assert.ok(!owns(left, right), `${left} was taken to satisfy ${right}`);
  }
});

test("an edition suffix on disk satisfies the plain catalogue title", () => {
  assert.ok(owns("Raping Uranus: The Lost Tracks", "Raping Uranus"));
  assert.ok(!owns("Raping Uranus", "Raping Uranus: The Lost Tracks"));
});

test("only titles naming more than one act are compared unordered", () => {
  // Matching without regard to order is looser than matching by string, and is
  // safe only where the order carries no meaning.
  assert.notEqual(splitParts(normalize("Spasm / Mizar")), null);
  assert.equal(splitParts(normalize("Objectif : Thunes")), null);
  assert.equal(splitParts(normalize("Abismo")), null);
});

test("normalize leaves nothing but folded words", () => {
  assert.equal(normalize("  The   Sunken   Norwegian!  "), "the sunken norwegian");
  assert.equal(normalize(""), "");
});

test("the abbreviation table is applied whole-word", () => {
  // "st" folds to "saint"; a word merely starting with it must not.
  assert.ok(ABBREV.st);
  assert.equal(normalize("Stone"), "stone");
});
