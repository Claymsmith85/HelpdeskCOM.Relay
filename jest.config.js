/**
 * Jest configuration for the CoreSpecialty Mail -> Helpdesk relay.
 *
 * - ts-jest compiles TypeScript on the fly using tsconfig.test.json (CommonJS output).
 * - Tests live next to source under src/ and are named *.test.ts.
 * - moduleNameMapper strips the ".js" extension that index.ts uses on its relative
 *   imports (NodeNext-style) so Jest can resolve them to the .ts sources.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/*.test.ts"],
  moduleFileExtensions: ["ts", "tsx", "js", "json", "node"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "tsconfig.test.json" }],
  },
  clearMocks: true,
  restoreMocks: true,
};
