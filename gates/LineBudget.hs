-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at https://mozilla.org/MPL/2.0/.
-- Copyright (c) 2026 2youg1 and the RefRain contributors

-- | No hand-maintained file exceeds 400 lines, and the files that already do
-- may only shrink.
--
-- A file nobody can hold in their head has no reviewer. Four hundred lines is
-- where this repository puts that boundary, and the number is a budget rather
-- than a style preference: `core.zig` at 2496 lines and `host.rs` at 1943 are
-- the two places a change most often lands in the wrong module, because the
-- right module is not visible from inside them.
--
-- The gate is a ratchet, not a cliff. Seventy-odd files are over budget today,
-- and refusing every commit until they are split would stop the repository
-- instead of improving it. So `gates/line-budget-debt.tsv` records each
-- violator with the count it had when the budget landed, and this gate holds
-- three separate lines:
--
--   1. a file with no debt row must stay within budget — new mass is refused;
--   2. a file with a debt row must not grow past its recorded count — the
--      existing mass may only fall;
--   3. a file whose debt row has fallen within budget must lose that row —
--      the debt list is self-cleaning, so it shrinks to nothing and then this
--      whole mechanism can be deleted rather than kept as folklore.
--
-- There is deliberately no @--write@ mode. Recording a new debt row is a human
-- edit that a reviewer sees, because the only reason to add one is to accept a
-- file nobody has split yet; a flag that rewrote the file on demand would turn
-- every regression green with one command.
--
-- Black-box by construction: it reads what `git ls-files` publishes and counts
-- bytes. It links no part of the product and knows nothing of its internals,
-- which is why it is Haskell and not Rust — see the verification section of
-- `docs/AGENTS.md` for the division.
--
-- Injection proof that this gate bites: append 401 lines to any file with no
-- debt row and it exits 1 naming that file; drop a line from a debt row's
-- recorded count and it exits 1 naming the row.
module Main (main) where

import qualified Data.ByteString.Char8 as Bytes
import Data.Char (isDigit)
import Data.List (isPrefixOf, isSuffixOf, sort)
import qualified Data.Map.Strict as Map
import Gate (Verdict (..), abort, readUtf8, report)
import System.Directory (doesFileExist)
import System.Exit (ExitCode (..))
import System.Process (readProcessWithExitCode)

gateName :: String
gateName = "verify:line-budget"

-- | The budget every hand-maintained file is held to.
budget :: Int
budget = 400

-- | Where the accepted violations are recorded, one per line, @path\\tcount@.
debtPath :: FilePath
debtPath = "gates/line-budget-debt.tsv"

-- | Why a tracked path is outside the budget.
--
-- The list is closed and the default is /in scope/: an extension nobody has
-- ruled on is counted, so a new file family cannot slip past the budget by
-- being unfamiliar. This mirrors the fail-closed classification
-- `scripts/licence-notice.ts` applies to the licence notice.
data Exemption
  = -- | Not lines at all; a count would describe the encoding.
    Binary
  | -- | A resolver writes the whole file; nobody reads it top to bottom.
    ToolOwned
  | -- | Not this project's to split.
    ThirdParty
  | -- | A generator owns the length. The generator itself is in scope.
    Generated
  deriving (Eq, Ord, Show)

-- | The sentence each exemption stands on, printed with the passing verdict so
-- that a reader can see what the budget did /not/ measure.
exemptionReason :: Exemption -> String
exemptionReason Binary = "not Source Code Form; a line count describes the encoding"
exemptionReason ToolOwned = "a resolver writes the whole file"
exemptionReason ThirdParty = "the content is not this project's to split"
exemptionReason Generated = "a generator owns the length; the generator is in scope"

-- | Extensions whose bytes are not lines.
binaryExtensions :: [String]
binaryExtensions = [".ttf", ".png", ".ico", ".zip", ".journal"]

-- | Paths a resolver writes whole.
toolOwnedPaths :: [FilePath]
toolOwnedPaths = ["Cargo.lock", "bun.lock"]

-- | Prefixes carrying somebody else's source.
thirdPartyPrefixes :: [FilePath]
thirdPartyPrefixes = ["patches/"]

-- | Generator output, kept in step with the table in @docs\/AGENTS.md@.
--
-- Two of these sit beside hand-written code rather than under a @generated@
-- directory, so no directory name can stand in for the list.
generatedPaths :: [FilePath]
generatedPaths =
  [ "apps/native/src/generated/protocol.ts",
    "apps/native/src/generated/protocol.zig",
    "apps/native/src/generated/wire.zig",
    "apps/native/src/generated/themes.zig",
    "apps/native/host/src/protocol.rs",
    "apps/native/host/src/wire.rs",
    "apps/native/host/include/refrain_native.h",
    "docs/SKILL.md"
  ]

-- | What the budget owes a path: nothing, or a count.
classify :: FilePath -> Maybe Exemption
classify path
  | any (`isSuffixOf` path) binaryExtensions = Just Binary
  | path `elem` toolOwnedPaths = Just ToolOwned
  | any (`isPrefixOf` path) thirdPartyPrefixes = Just ThirdParty
  | path == "LICENSE-THIRD-PARTY" = Just ThirdParty
  | path `elem` generatedPaths = Just Generated
  | otherwise = Nothing

-- | Lines in a file, counted from bytes so that no locale can change the
-- answer. A final line without a terminator still counts as a line, which is
-- how an editor shows it and how a reviewer reads it.
countLines :: Bytes.ByteString -> Int
countLines content
  | Bytes.null content = 0
  | otherwise = Bytes.count '\n' content + terminator
  where
    terminator = if Bytes.last content == '\n' then 0 else 1

-- | One accepted violation.
data Debt = Debt {debtFile :: FilePath, debtLines :: Int}

-- | Parse the recorded debt, refusing anything it cannot read exactly.
--
-- A malformed row is an error rather than a skipped line: a row silently
-- dropped would raise the ceiling on the file it names back to infinity.
parseDebt :: String -> Either String [Debt]
parseDebt = traverse row . filter interesting . zip [1 :: Int ..] . lines
  where
    interesting (_, line) = not (null (trim line)) && not ("#" `isPrefixOf` trim line)
    row (number, line) = case break (== '\t') line of
      (path, '\t' : count)
        | not (null (trim path)),
          all isDigit (trim count),
          not (null (trim count)) ->
            Right (Debt (trim path) (read (trim count)))
      _ -> Left (debtPath <> ":" <> show number <> ": expected <path>\\t<lines>, read " <> show line)

trim :: String -> String
trim = dropWhile (== ' ') . reverse . dropWhile (\c -> c == ' ' || c == '\r') . reverse

-- | Every path a commit from here would carry: what git already tracks, plus
-- what is present and not ignored.
--
-- The untracked half is not decoration. A file is at its longest on the day it
-- is written, and a gate that measured only the index would first see it after
-- the commit that made it too long. It also gives the gate an injection: a
-- 401-line file dropped into the tree must turn it red without being staged.
trackedFiles :: IO (Either String [FilePath])
trackedFiles = do
  (code, out, err) <- readProcessWithExitCode "git" ["ls-files", "--cached", "--others", "--exclude-standard"] ""
  pure $ case code of
    ExitSuccess -> Right (filter (not . null) (lines out))
    ExitFailure status -> Left ("git ls-files exited " <> show status <> ": " <> trim err)

-- | A file that has vanished between @git ls-files@ and the read is reported,
-- never counted as zero: a zero would clear a debt row by accident.
measure :: FilePath -> IO (Either String (FilePath, Int))
measure path = do
  present <- doesFileExist path
  if not present
    then pure (Left (path <> ": tracked by git but absent from the working tree"))
    else do
      content <- Bytes.readFile path
      pure (Right (path, countLines content))

main :: IO ()
main = do
  tracked <- trackedFiles
  files <- either die pure tracked
  let inScope = sort [path | path <- files, classify path == Nothing]
      exempt = [reason | path <- files, Just reason <- [classify path]]

  -- A scan that finds nothing is a broken scan, not a tidy repository. This
  -- floor is what tells a moved scan face apart from a clean verdict.
  case inScope of
    [] -> die "found no files to measure — the scan face moved"
    _ -> pure ()

  measured <- traverse measure inScope
  counts <- either die pure (sequence measured)
  let sizeOf = Map.fromList counts

  debtPresent <- doesFileExist debtPath
  recorded <-
    if debtPresent
      then readUtf8 debtPath
      else die (debtPath <> " is missing; the recorded debt is what bounds the ratchet")
  debts <- either die pure (parseDebt recorded)
  let ceilings = Map.fromList [(debtFile debt, debtLines debt) | debt <- debts]

  let overBudget =
        [ path <> "  " <> show count <> " lines, budget " <> show budget
          | (path, count) <- counts,
            not (Map.member path ceilings),
            count > budget
        ]
      grown =
        [ path <> "  grew to " <> show count <> " lines; " <> debtPath <> " records " <> show ceiling
          | (path, count) <- counts,
            Just ceiling <- [Map.lookup path ceilings],
            count > ceiling
        ]
      paid =
        [ path <> "  is within budget at " <> show count <> " lines; delete its row from " <> debtPath
          | (path, count) <- counts,
            Map.member path ceilings,
            count <= budget
        ]
      stale =
        [ debtFile debt <> "  has a debt row but is not a measured file; delete the row"
          | debt <- debts,
            not (Map.member (debtFile debt) sizeOf)
        ]
      findings = sort (overBudget <> grown <> paid <> stale)

  report
    Verdict
      { gate = gateName,
        summary =
          show (length inScope - length debts)
            <> " files within "
            <> show budget
            <> " lines, "
            <> show (length debts)
            <> " carrying recorded debt, "
            <> show (length exempt)
            <> " exempt",
        detail = exemptionSummary exempt,
        findings = findings
      }

-- | One row per exemption kind, so the reader sees what went unmeasured.
exemptionSummary :: [Exemption] -> [String]
exemptionSummary exemptions =
  [ show count <> " " <> show kind <> ": " <> exemptionReason kind
    | (kind, count) <- Map.toList (Map.fromListWith (+) [(kind, 1 :: Int) | kind <- exemptions])
  ]

die :: String -> IO a
die = abort gateName
