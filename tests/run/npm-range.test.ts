import { expect, test } from "vitest";
import { npmLockKeeps } from "../../src/run/npm-range.js";

// Queue row 290 / D-2173 add.2: closed answers from npm's bundled semver 7.8.5,
// with loose=true and includePrerelease=false. Expected decisions are literals;
// neither the shipped check nor its tests depend on a transitive semver import.
type Case = [spec: string, locked: string, keeps: boolean];
const check = (cases: Case[]) => {
  for (const [spec, locked, keeps] of cases) {
    expect(npmLockKeeps(spec, locked), `${JSON.stringify(spec)} at ${JSON.stringify(locked)}`).toBe(keeps);
  }
};

test("the range check keeps a lock that each range form of the closed spec table accepts and resolves again one it rejects, so an unsatisfying pin fails", () => {
  check([
    ["^2.0.0", "1.4.0", false], ["^2.0.0", "2.9.0", true],
    ["^1.0.0", "1.5.0", true], ["^1.0.0", "2.0.0", false],
    ["~1.2.0", "1.2.9", true], ["~1.2.0", "1.3.0", false],
    ["2.x", "2.9.0", true], ["2.x", "1.9.0", false],
    [">=1.2.0 <2", "1.9.0", true], [">=1.2.0 <2", "2.0.0", false],
    ["^3 || ^4", "4.1.0", true], ["^3 || ^4", "3.1.0", true], ["^3 || ^4", "2.1.0", false],
    // Hyphen ranges include complete endpoints and expand partial endpoints.
    ["1.2.3 - 2.3.4", "1.2.3", true], ["1.2.3 - 2.3.4", "2.3.4", true],
    ["1.2.3 - 2.3.4", "1.2.2", false], ["1.2.3 - 2.3.4", "2.3.5", false],
    ["1.2 - 2.3", "1.2.0", true], ["1.2 - 2.3", "2.3.99", true], ["1.2 - 2.3", "2.4.0", false],
    ["1 - 2", "2.99.99", true], ["1 - 2", "3.0.0", false],
    ["* - 2", "0.0.0", true], ["1 - *", "99.0.0", true], ["* - *", "99.0.0", true],
    ["1.2.x - 2.3.x", "2.3.99", true], ["1.2.x - 2.3.x", "2.4.0", false],
    ["1.2.3-2.3.4", "1.2.3", false], // A prerelease, not a hyphen range.
    ["1.2.3 - 2.3.4 <3", "2.0.0", false], // Hyphen expansion requires the whole union member.
    // Comparator operators, missing components, and whitespace after operators.
    [">1.2.3", "1.2.3", false], [">1.2.3", "1.2.4", true],
    [">= 1.2.0", "1.2.0", true], [">= 1.2.0", "1.1.9", false],
    ["<=1.2.3", "1.2.3", true], ["<=1.2.3", "1.2.4", false],
    ["<1.2.3", "1.2.2", true], ["<1.2.3", "1.2.3", false],
    [">1", "1.99.0", false], [">1", "2.0.0", true],
    [">1.2", "1.2.99", false], [">1.2", "1.3.0", true],
    ["<=1", "1.99.0", true], ["<=1", "2.0.0", false],
    ["<=1.2", "1.2.99", true], ["<=1.2", "1.3.0", false],
    ["<1", "0.99.0", true], ["<1", "1.0.0", false],
    ["<1.2", "1.1.99", true], ["<1.2", "1.2.0", false],
    [">=1.2", "1.2.0", true], [">=1.2", "1.1.99", false],
    ["  >=\t1.2.3\n < 2  ", "1.5.0", true],
    ["= 1.2.3", "1.2.3", true], ["= 1.2.3", "1.2.4", false],
    [">=1.2.3<2", "1.5.0", false], [">=1.2.3, <2", "1.5.0", true],
    // Tildes, including ~>, and carets differ at zero-major boundaries.
    ["~>1.2", "1.2.9", true], ["~>1.2", "1.3.0", false],
    ["~> 1.2.3", "1.2.9", true], ["~> 1.2.3", "1.3.0", false],
    ["~1", "1.9.9", true], ["~1", "2.0.0", false],
    ["~0.0.1", "0.0.9", true], ["~0.0.1", "0.1.0", false],
    ["~*", "9.9.9", true], ["~1.x", "1.9.9", true], ["~1.2.x", "1.3.0", false],
    ["^ 1.2.3", "1.9.0", true], ["^ 1.2.3", "2.0.0", false],
    ["^0.2.3", "0.2.9", true], ["^0.2.3", "0.3.0", false],
    ["^0.0.3", "0.0.3", true], ["^0.0.3", "0.0.4", false],
    ["^0.0", "0.0.9", true], ["^0.0", "0.1.0", false],
    ["^0", "0.9.0", true], ["^0", "1.0.0", false],
    ["^0.x", "0.9.0", true], ["^0.x", "1.0.0", false],
    ["^1.2.x", "1.9.0", true], ["^1.2.x", "2.0.0", false], ["^*", "9.0.0", true],
    ["^00.0.3", "0.9.0", true], // Loose expansion preserves the raw zero spelling.
    ["~01.02.03", "1.2.9", true], ["~01.02.03", "1.3.0", false],
    // x/star ranges and their operator forms.
    ["1", "1.9.9", true], ["1", "2.0.0", false],
    ["1.2", "1.2.9", true], ["1.2", "1.3.0", false],
    ["1.X", "1.9.9", true], ["1.X", "2.0.0", false],
    ["1.2.*", "1.2.9", true], ["1.2.*", "1.3.0", false],
    ["=1.x", "1.2.3", true], ["=1.x", "2.0.0", false],
    [">1.x", "1.9.0", false], [">1.x", "2.0.0", true],
    ["<=1.2.x", "1.2.99", true], ["<=1.2.x", "1.3.0", false],
    [">=*", "3.0.0", true], ["<=*", "3.0.0", true],
    [">*", "3.0.0", false], ["<*", "0.0.0", false],
    ["x.x", "9.9.9", true], ["X.*.x", "9.9.9", true],
    // Exact versions, loose v/= prefixes, and ignored build metadata.
    ["1.2.3", "1.2.3", true], ["1.2.3", "1.2.4", false],
    ["v1.4.0", "1.4.0", true], ["v1.4.0", "1.5.0", false],
    ["=v1.2.3", "1.2.3", true], ["==1.2.3", "1.2.3", true],
    ["vv1.2.3", "1.2.3", true], ["01.02.003", "1.2.3", true],
    ["1.2.3+build.9", "1.2.3+other.8", true], ["^1.2.3+build.9", "1.5.0", true],
    ["1.2+build", "1.2.9", true], ["1+build - 2+build", "2.9.0", true],
    ["^1.2.3+build", "2.0.0", false], ["1.2.3+build", "1.2.4", false],
    // Loose parsing discards bad comparator tokens/members rather than rejecting a whole range.
    ["garbage ^1", "1.5.0", true], ["garbage ^1", "2.0.0", false],
    ["garbage || ^1", "1.5.0", true], ["garbage || ^1", "2.0.0", false],
    ["^1 | ^2", "1.5.0", false], ["^1 | garbage", "1.5.0", true],
    ["^1 ||", "9.0.0", true], ["|| ^1", "9.0.0", true],
    ["<* || ^1", "1.5.0", true], ["<* || >*", "0.0.0", false],
    ["<0.0.0-0 >=9007199254740992.0.0 || ^1", "1.5.0", false],
    ["^1.2.3.4", "1.4.0", false],
  ]);
});

test("the range check admits a prerelease only through a comparator on the same release triple after a union holding the star collapses to it, so a prerelease kept by another union member fails", () => {
  check([
    ["^1.0.0", "1.5.0-beta.1", false],
    ["^2.0.0-beta.0", "2.0.0-beta.1", true], ["^2.0.0-beta.0", "2.0.1-beta.1", false],
    ["^2.0.0-beta.0", "2.0.0-alpha.1", false], ["^2.0.0-beta.0", "2.0.0", true],
    ["~1.2.3-beta.0", "1.2.3-beta.1", true], ["~1.2.3-beta.0", "1.2.4-beta.1", false],
    ["^0.0.3-beta.0", "0.0.3-beta.1", true], ["^0.0.3-beta.0", "0.0.4-beta.1", false],
    ["^0.2.3-beta.0", "0.2.3-beta.1", true], ["^0.2.3-beta.0", "0.3.0-beta.1", false],
    [">=1.2.3-alpha <2", "1.2.3-beta", true], [">=1.2.3-alpha <2", "1.2.4-beta", false],
    [">=1.2.3-alpha <2", "1.3.3-beta", false], [">=1.2.3-alpha <2", "2.2.3-beta", false],
    [">=1 <2.0.0-beta.2", "2.0.0-beta.1", true], // An upper comparator can admit prereleases.
    ["1.2.3-alpha - 2.3.4-beta", "1.2.3-beta", true],
    ["1.2.3-alpha - 2.3.4-beta", "2.3.4-alpha", true],
    ["1.2.3-alpha - 2.3.4-beta", "1.3.0-alpha", false],
    ["1.2.3beta.1", "1.2.3-beta.1", true], ["1.2.3beta.1", "1.2.3-beta.2", false],
    ["1.2.3-beta.01+build", "1.2.3-beta.1+other", true],
    ["^2 || ^2.0.0-beta.0", "2.0.0-beta.1", true],
    ["* || ^2.0.0-beta.0", "2.0.0-beta.1", false],
    ["^2.0.0-beta.0 || *", "2.0.0-beta.1", false],
    ["<* || * || ^2.0.0-beta.0", "2.0.0-beta.1", false],
    ["<* || ^2.0.0-beta.0", "2.0.0-beta.1", true],
    ["<* || *", "2.0.0-beta.1", false],
    [">=0.0.0 || ^2.0.0-beta.0", "2.0.0-beta.1", false],
    ["x || ^2.0.0-beta.0", "2.0.0-beta.1", false],
    [" || ^2.0.0-beta.0", "2.0.0-beta.1", false],
    ["* >=2.0.0-beta.0", "2.0.0-beta.1", true],
    ["* >=2.0.0", "2.0.0-beta.1", false],
    ["1.x || ^2.0.0-beta.0", "1.2.3-beta.1", false],
    ["*", "2.0.0-beta.1", true], ["x", "2.0.0-beta.1", false],
    ["", "2.0.0-beta.1", false], [">=0.0.0", "2.0.0-beta.1", false],
  ]);
});

test("the range check orders an all-digit prerelease identifier below a text one whatever its size, so identifiers ordered by storage type fail", () => {
  check([
    [">=1.0.0-1alpha", "1.0.0-9007199254740992", false],
    ["<1.0.0-1alpha", "1.0.0-9007199254740992", true],
    [">=1.0.0-9007199254740992", "1.0.0-1alpha", true],
    ["<1.0.0-9007199254740992", "1.0.0-1alpha", false],
    [">=1.0.0-1alpha", "1.0.0-99999999999999999999999999999999999999", false],
    [">=1.0.0-alpha.1alpha", "1.0.0-alpha.9007199254740992", false],
    [">=1.0.0-2", "1.0.0-10", true], [">=1.0.0-10", "1.0.0-2", false],
    [">=1.0.0-9007199254740992", "1.0.0-9007199254740991", false],
    [">=1.0.0-9007199254740991", "1.0.0-9007199254740992", true],
    ["1.0.0-9007199254740992", "1.0.0-9007199254740993", true], // npm's numeric coercion rounds both.
    ["1.0.0-01", "1.0.0-1", true], ["1.0.0-0009007199254740992", "1.0.0-9007199254740992", true],
    [">1.0.0-alpha", "1.0.0-alpha.0", true], ["<1.0.0-alpha.0", "1.0.0-alpha", true],
    [">1.0.0-alpha.1", "1.0.0-alpha.1", false], ["<=1.0.0-alpha.1", "1.0.0-alpha.1", true],
    [">1.0.0-alpha", "1.0.0-beta", true], [">1.0.0-beta", "1.0.0-alpha", false],
    [">1.0.0-A", "1.0.0-a", true], [">1.0.0-a", "1.0.0-A", false],
  ]);
});

test("the range check keeps the lock for the star and a URI-safe dist-tag but resolves again a spec npm refuses or a lock that is no version, so a check that drops a tag's lock fails", () => {
  check([
    ["*", "1.2.3", true], [" * ", "1.2.3-beta.1", true],
    ["latest", "1.2.3", true], ["next", "1.2.3-beta.1", true],
    ["1.2.3.4", "4.4.3", true], ["release-2026.10", "1.2.3", true],
    ["tag!'()_-.~*", "1.2.3", true], [" latest ", "1.2.3", true],
    ["x.1", "1.2.3", true], ["1.x.2", "1.2.3", true], // Not ranges; URI-safe tags.
    ["^x.1", "1.2.3", true], ["~1.x.2", "1.2.3", true], // Compatible ranges expand before x validation.
    ["^1.2.3.4", "1.2.3", false], ["~1.2.3.4", "1.2.3", true], // '~' is URI-safe; '^' is not.
    [">=x.1", "1.2.3", false], [">=1.x.2", "1.2.3", false],
    ["latest beta", "1.2.3", false], ["beta/next", "1.2.3", false],
    ["tag+build", "1.2.3", false], ["tag#branch", "1.2.3", false],
    ["tag%20", "1.2.3", false], ["tag@next", "1.2.3", false],
    ["tag:next", "1.2.3", false], ["tag?next", "1.2.3", false],
    ["café", "1.2.3", false], ["\ud800", "1.2.3", false],
    ["^1", "git+https://example.invalid/repo.git#main", false],
    ["latest", "git+https://example.invalid/repo.git#main", false],
    ["*", "not-a-version", false], ["latest", "1.2", false], ["*", "1.2.3.4", false],
    ["^1", "file:../pkg", false], ["^1", "npm:real@1.2.3", false],
    ["*", "9007199254740992.0.0", false], ["*", "1.9007199254740992.0", false],
    ["*", "1.0.9007199254740992", false], ["*", "", false],
    ["^1", "v01.02.003+metadata", true],
    ["9007199254740992.0.0", "1.2.3", true], // Overlarge version becomes a tag.
    [">=9007199254740992.0.0", "1.2.3", false],
    ["^9007199254740991.0.0", "1.2.3", false], // Expansion overflows the upper bound.
    ["latest", "1.0.0-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", false],
  ]);
});
