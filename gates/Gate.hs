-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at https://mozilla.org/MPL/2.0/.
-- Copyright (c) 2026 2youg1 and the RefRain contributors

-- | How a black-box gate reads this repository, and how it speaks.
--
-- Not a program: this module carries no @main@, and @verify:gates-run@ asks
-- for one before it calls a file in @gates\/@ a gate. Two things live here
-- because both are policy that every gate must apply the same way, and neither
-- is a rename of something the standard library already offers.
--
-- __Reading.__ 'readUtf8' opens a file as UTF-8 whatever the machine's locale
-- says. @readFile@ decodes through the locale, so on a Windows console set to
-- CP936 it dies with @invalid argument (cannot decode byte sequence)@ the
-- moment a file holds a Chinese comment — which files in this repository do.
-- The failure is per-machine: the same commit is green on a runner and red on
-- the author's laptop, which is the least useful shape a gate can have.
--
-- __Speaking.__ 'report' prints the one line a reader greps for and nothing
-- else on a pass. The shape is fixed by @scripts\/gate.ts@ and by the
-- annotation step in @.github\/actions\/run-gate@: they lift @^FAIL@ out of a
-- log where sixteen stages interleave, so a gate that invents its own prefix
-- disappears from the only channel a person without repository rights can read.
module Gate
  ( readUtf8,
    Verdict (..),
    report,
    abort,
  )
where

import System.Exit (exitFailure, exitSuccess)
import System.IO
  ( IOMode (ReadMode),
    hGetContents',
    hSetEncoding,
    openFile,
    stdout,
    utf8,
  )

-- | A file's text, decoded as UTF-8 on every machine.
--
-- Strict, so the handle is closed before the caller looks at the result: a gate
-- that holds a lazy handle open cannot be followed by one that rewrites the
-- same file, which is exactly what the injection proofs do.
readUtf8 :: FilePath -> IO String
readUtf8 path = do
  handle <- openFile path ReadMode
  hSetEncoding handle utf8
  hGetContents' handle

-- | What one gate concluded.
data Verdict = Verdict
  { -- | The gate's name, spelled as @scripts/gate.ts@ spells it.
    gate :: String,
    -- | The reading a pass reports, shown in parentheses after the name.
    summary :: String,
    -- | What the pass measured, one row each. Printed only on a pass.
    detail :: [String],
    -- | What is wrong. Empty is a pass; the gate's exit status follows it.
    findings :: [String]
  }

-- | Print the verdict and exit with the status it implies.
report :: Verdict -> IO a
report verdict = do
  hSetEncoding stdout utf8
  case findings verdict of
    [] -> do
      putStrLn ("PASS  " <> gate verdict <> "  (" <> summary verdict <> ")")
      mapM_ indented (detail verdict)
      exitSuccess
    problems -> do
      putStrLn ("FAIL  " <> gate verdict)
      mapM_ indented problems
      exitFailure
  where
    indented row = putStrLn ("      " <> row)

-- | Stop because the gate could not run at all.
--
-- Separate from a finding on purpose: "the repository is wrong" and "I could
-- not look" are different facts, and a gate that reports the second as the
-- first sends somebody to fix a file that is fine.
abort :: String -> String -> IO a
abort name reason = do
  hSetEncoding stdout utf8
  putStrLn ("FAIL  " <> name <> ": " <> reason)
  exitFailure
