-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at https://mozilla.org/MPL/2.0/.
-- Copyright (c) 2026 2youg1 and the RefRain contributors

-- | A patched dependency is patched, or the build stops.
--
-- Bun applies a patch only when the key in @patchedDependencies@ matches the
-- version the lockfile resolved, character for character. When the two
-- disagree it applies nothing, prints nothing, and exits zero. The
-- modification is gone and every gate stays green, because no gate reads the
-- vendor's installed bytes.
--
-- This repository has already paid for that. Dependabot PR #38 moved
-- @\@native-sdk\/cli@ from 0.10.0 to 0.10.1 and merged; the key stayed at
-- 0.10.0. Measured on the installed tree afterwards: the resolved package was
-- 0.10.1 and the patched line — a guard around the Zig analysis object that
-- Windows cannot link — was absent from @build\/app.zig@.
--
-- The lockfile said so too, by saying nothing. @bun.lock@ carries a
-- @patchedDependencies@ block recording the patches bun actually applied, and
-- it had none: the block appeared only after the key was repaired and
-- @bun install@ ran again. So this gate does not infer what bun would do from
-- a manifest. It reads bun's own record of what bun did, which is why it needs
-- no install of its own to be decisive.
--
-- The general shape is a second authority for a version. This repository knows
-- it: the workflows once installed ScriptC 0.0.21 while the lockfile pinned
-- 0.0.35, and @verify:release-workflow@ now refuses a version literal in a
-- workflow. The same disease, the same treatment — the lockfile resolves, and
-- every other statement of the version is either derived or checked here. If a
-- third instance appears, these two gates should merge into one; two is not
-- yet a pattern.
--
-- What it holds:
--
--   1. every key names a package the lockfile resolves exactly once;
--   2. the key's version equals the resolved version, and @bun.lock@ records
--      that same key and path under its own @patchedDependencies@ — the
--      declaration and the effect, checked separately, because the first is
--      what a human wrote and the second is what the tool did;
--   3. the patch file the value names exists;
--   4. the file's name carries no version at all. @bun patch --commit@ writes
--      @name\@version.patch@, and every such name is a second statement of a
--      fact only the lockfile owns: it goes stale at the next bump, and the
--      scripts that name the path go stale with it. A version-free name leaves
--      exactly one version outside the lockfile — the key bun requires — and
--      rule 2 pins that one. The tool's default is refused here rather than
--      accepted and then chased;
--   5. every file under @patches\/@ is named by some key — an orphan patch
--      file reads as a live modification and is not one.
--
-- Injection proof that this gate bites: change the key's version to one the
-- lockfile does not resolve and it exits 1 naming the package.
module Main (main) where

import Data.List (isPrefixOf, sort)
import Gate (Verdict (..), abort, readUtf8, report)
import System.Directory (doesDirectoryExist, doesFileExist, listDirectory)

gateName :: String
gateName = "verify:patched-dependency"

manifestPath :: FilePath
manifestPath = "package.json"

lockPath :: FilePath
lockPath = "bun.lock"

patchDirectory :: FilePath
patchDirectory = "patches"

-- | One declared modification to a dependency.
data Patch = Patch
  { -- | The package name, without the version.
    patchPackage :: String,
    -- | The version the key names, which bun matches exactly.
    patchVersion :: String,
    -- | The file the key points at, relative to the repository root.
    patchFile :: FilePath
  }

-- | The first substring match, as the text that follows it.
after :: String -> String -> Maybe String
after needle haystack
  | needle `isPrefixOf` haystack = Just (drop (length needle) haystack)
  | otherwise = case haystack of
      [] -> Nothing
      _ : rest -> after needle rest

-- | How many times a needle occurs. Two occurrences of one package name mean
-- the lockfile resolved it twice, and a patch then reaches one of them.
occurrences :: String -> String -> Int
occurrences needle haystack = go haystack
  where
    go text = case after needle text of
      Nothing -> 0
      Just rest -> 1 + go rest

-- | Read a JSON string literal, honouring backslash escapes.
--
-- Written out rather than pulled from a JSON package because the gate must run
-- under a bare @runghc@ with no dependency resolution: its whole toolchain is
-- the compiler the runner image already carries.
readString :: String -> Maybe (String, String)
readString ('"' : rest) = go rest ""
  where
    go ('\\' : c : more) acc = go more (c : acc)
    go ('"' : more) acc = Just (reverse acc, more)
    go (c : more) acc = go more (c : acc)
    go [] _ = Nothing
readString (c : rest) | c `elem` " \t\r\n" = readString rest
readString _ = Nothing

-- | The @patchedDependencies@ object of one file, empty when it has none.
--
-- Both files spell it the same way: @package.json@ as the declaration a human
-- wrote, @bun.lock@ as bun's record of what it applied.
patchedBlock :: FilePath -> String -> IO [(String, String)]
patchedBlock path text = case after "\"patchedDependencies\"" text of
  Nothing -> pure []
  Just rest -> case dropWhile (`elem` " \t\r\n") rest of
    ':' : body -> case readPairs body of
      Nothing -> die (path <> ": patchedDependencies is not a flat object of strings")
      Just pairs -> pure pairs
    _ -> die (path <> ": patchedDependencies has no value")

-- | The flat @string: string@ pairs of one JSON object, in source order.
readPairs :: String -> Maybe [(String, String)]
readPairs text = case dropWhile (`elem` " \t\r\n") text of
  '{' : rest -> go rest []
  _ -> Nothing
  where
    go body acc = case dropWhile (`elem` " \t\r\n,") body of
      '}' : _ -> Just (reverse acc)
      candidate -> do
        (key, afterKey) <- readString candidate
        rest <- case dropWhile (`elem` " \t\r\n") afterKey of
          ':' : more -> Just more
          _ -> Nothing
        (value, afterValue) <- readString rest
        go afterValue ((key, value) : acc)

-- | Split @name\@version@ at the version separator, which is the last @\@@
-- because a scoped package name opens with one.
splitVersion :: String -> Maybe (String, String)
splitVersion key = case break (== '@') (reverse key) of
  (reversedVersion, '@' : reversedName)
    | not (null reversedVersion), not (null reversedName) ->
        Just (reverse reversedName, reverse reversedVersion)
  _ -> Nothing

-- | The version @bun.lock@ resolved for a package, taken from its entry in the
-- packages block: @"name": ["name\@version", …]@.
resolvedVersion :: String -> String -> Maybe String
resolvedVersion lockText name =
  takeWhile (/= '"') <$> after ("\"" <> name <> "\": [\"" <> name <> "@") lockText

main :: IO ()
main = do
  manifest <- readUtf8 manifestPath
  lockText <- readUtf8 lockPath

  declared <- patchedBlock manifestPath manifest
  applied <- patchedBlock lockPath lockText

  patches <- traverse parse declared
  findings <- concat <$> traverse (check lockText applied) patches

  onDisk <- patchFilesOnDisk
  let named = [patchFile patch | patch <- patches]
      orphans =
        [ path <> "  is in " <> patchDirectory <> "/ but no patchedDependencies key names it"
          | path <- onDisk,
            path `notElem` named
        ]

  -- A gate that measured nothing must not report that nothing was wrong. Zero
  -- patches with zero files is a real and clean answer; zero patches with files
  -- on disk is caught above.
  report
    Verdict
      { gate = gateName,
        summary =
          show (length patches)
            <> " patched dependencies match the version "
            <> lockPath
            <> " resolved",
        detail = [patchPackage p <> "@" <> patchVersion p | p <- patches],
        findings = sort (findings <> orphans)
      }
  where
    parse (key, value) = case splitVersion key of
      Nothing -> die (manifestPath <> ": patchedDependencies key " <> show key <> " is not name@version")
      Just (name, version) -> pure (Patch name version value)

-- | The file name alone; a repository path never contains a directory named
-- with @\@@ here, but the check must speak about the name it asks a human to
-- change.
baseName :: FilePath -> String
baseName path = reverse (takeWhile (/= '/') (reverse path))

-- | Every regular file under @patches/@, which is where a modification hides
-- when its key stops naming it.
patchFilesOnDisk :: IO [FilePath]
patchFilesOnDisk = do
  present <- doesDirectoryExist patchDirectory
  if not present
    then pure []
    else do
      entries <- listDirectory patchDirectory
      pure (sort [patchDirectory <> "/" <> entry | entry <- entries])

-- | The findings for one declared patch. Every arm names the package, so a red
-- says which dependency lost its modification.
check :: String -> [(String, String)] -> Patch -> IO [String]
check lockText applied patch = do
  present <- doesFileExist (patchFile patch)
  let key = patchPackage patch <> "@" <> patchVersion patch
      appliedFinding = case lookup key applied of
        Nothing ->
          [ patchPackage patch
              <> "  is declared in "
              <> manifestPath
              <> " but "
              <> lockPath
              <> " records no patch for "
              <> key
              <> "; bun applied nothing. Run `bun install` and commit the lockfile."
          ]
        Just recordedPath
          | recordedPath /= patchFile patch ->
              [ patchPackage patch
                  <> "  is declared at "
                  <> patchFile patch
                  <> " while "
                  <> lockPath
                  <> " records "
                  <> recordedPath
                  <> "; bun applied the other file"
              ]
          | otherwise -> []
      name = patchPackage patch
      declaredVersion = patchVersion patch
      resolved = resolvedVersion lockText name
      count = occurrences ("\"" <> name <> "\": [\"" <> name <> "@") lockText
      versionFinding = case resolved of
        Nothing ->
          [ name
              <> "  is patched but "
              <> lockPath
              <> " resolves no version for it; bun applies the patch to nothing"
          ]
        Just actual
          | actual /= declaredVersion ->
              [ name
                  <> "  patchedDependencies names "
                  <> declaredVersion
                  <> " while "
                  <> lockPath
                  <> " resolves "
                  <> actual
                  <> "; bun applies the patch silently to nothing. Re-cut it with"
                  <> " `bun patch "
                  <> name
                  <> "` and rename the file to match."
              ]
          | count /= 1 ->
              [ name
                  <> "  is resolved "
                  <> show count
                  <> " times in "
                  <> lockPath
                  <> "; a patch reaches one of them and the rest go unmodified"
              ]
          | otherwise -> []
      fileFinding =
        [name <> "  names " <> patchFile patch <> ", which does not exist" | not present]
      nameFinding =
        [ name
            <> "  names "
            <> patchFile patch
            <> ", whose file name states a version. Rename it without one"
            <> " (`bun patch --commit` writes the version in by default): the"
            <> " lockfile owns the version, and a name carrying it goes stale at"
            <> " the next bump together with every script that names the path."
          | present,
            '@' `elem` baseName (patchFile patch)
        ]
  pure (versionFinding <> appliedFinding <> fileFinding <> nameFinding)

die :: String -> IO a
die = abort gateName
