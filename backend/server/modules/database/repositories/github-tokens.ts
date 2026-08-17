// Simplified edition: GitHub credential storage removed. Stub kept so the
// project-clone service compiles; cloning without a stored token will surface
// a normal "no token" error at runtime instead of failing the build.

export const githubTokensDb = {
  getGithubTokenById(_userId: number, _tokenId: number): unknown {
    return undefined;
  },
};
