class Friction < Formula
  desc "Disagreement engine for AI-assisted code"
  homepage "https://github.com/friction-labs/friction"
  url "https://github.com/friction-labs/friction/releases/download/v0.7.0/friction-macos-universal.tar.gz"
  sha256 "REPLACE_WITH_RELEASE_SHA256"
  license "MIT"

  def install
    bin.install "friction"
  end

  test do
    assert_match "Friction", shell_output("#{bin}/friction --help")
  end
end
