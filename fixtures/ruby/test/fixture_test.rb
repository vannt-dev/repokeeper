require "minitest/autorun"
require "fixture"

class FixtureTest < Minitest::Test
  def test_greets_by_name
    assert_equal "Hello, Ada!", Fixture.greet("Ada")
  end
end
