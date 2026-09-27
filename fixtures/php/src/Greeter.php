<?php

declare(strict_types=1);

namespace Fixture;

final class Greeter
{
    public static function greet(string $name): string
    {
        return "Hello, {$name}!";
    }
}
