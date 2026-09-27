<?php

declare(strict_types=1);

use Fixture\Greeter;
use PHPUnit\Framework\TestCase;

final class GreeterTest extends TestCase
{
    public function testGreetsByName(): void
    {
        self::assertSame('Hello, Ada!', Greeter::greet('Ada'));
    }
}
